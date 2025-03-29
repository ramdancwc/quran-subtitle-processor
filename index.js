require('dotenv').config();
const express = require('express');
const AWS = require('aws-sdk');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

// Initialize Express app
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(cors());

// Configure AWS
AWS.config.update({
  region: process.env.AWS_REGION,
  accessKeyId: process.env.AWS_ACCESS_KEY,
  secretAccessKey: process.env.AWS_SECRET_KEY
});

// Initialize AWS services
const s3 = new AWS.S3();
const mediaConvert = new AWS.MediaConvert({
  endpoint: process.env.MEDIACONVERT_ENDPOINT
});

// Simple in-memory job tracking (would use a database in production)
const jobsDB = {};

// Home route
app.get('/', (req, res) => {
  res.send('Quran Subtitle Processor is running');
});

// Endpoint to create a processing job
app.post('/process', async (req, res) => {
  try {
    console.log('Received process request');
    const { videoUrl, verses, subtitlePreferences, subtitleOffset } = req.body;
    
    if (!videoUrl || !verses || !Array.isArray(verses) || verses.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: videoUrl and verses array'
      });
    }
    
    console.log(`Processing video: ${videoUrl}`);
    console.log(`Received ${verses.length} verses`);
    
    // Generate a unique job ID
    const jobId = uuidv4();
    console.log(`Created job ID: ${jobId}`);
    
    // Generate ASS content for better subtitle formatting
    const assContent = generateASS(verses, { ...subtitlePreferences, subtitleOffset: subtitleOffset || 0 });
    console.log('Generated ASS content');
    
    // Upload ASS to S3
    const assKey = `subtitles/${jobId}.ass`;
    console.log(`Uploading ASS to S3: ${assKey}`);
    
    await s3.putObject({
      Bucket: process.env.S3_BUCKET,
      Key: assKey,
      Body: assContent,
      ContentType: 'text/plain'
    }).promise();
    
    console.log('ASS file uploaded successfully');
    
    // Download video from Supabase URL to memory
    console.log('Downloading video from Supabase...');
    const videoResponse = await fetch(videoUrl);
    
    if (!videoResponse.ok) {
      throw new Error(`Failed to download video: ${videoResponse.statusText}`);
    }
    
    const videoBuffer = await videoResponse.arrayBuffer();
    console.log(`Video downloaded: ${videoBuffer.byteLength} bytes`);
    
    // Upload video to S3
    const videoKey = `inputs/${jobId}.mp4`;
    console.log(`Uploading video to S3: ${videoKey}`);
    
    await s3.putObject({
      Bucket: process.env.S3_BUCKET,
      Key: videoKey,
      Body: Buffer.from(videoBuffer),
      ContentType: 'video/mp4'
    }).promise();
    
    console.log('Video uploaded to S3 successfully');
    
    // Now use S3 path for the video input
    const s3VideoUrl = `s3://${process.env.S3_BUCKET}/${videoKey}`;
    
    // Create MediaConvert job
    const outputKey = `outputs/${jobId}.mp4`;
    const params = createMediaConvertParams(s3VideoUrl, assKey, outputKey, subtitlePreferences || {});
    
    console.log('Creating MediaConvert job...');
    const job = await mediaConvert.createJob(params).promise();
    console.log(`MediaConvert job created: ${job.Job.Id}`);
    
    // Store job info
    jobsDB[jobId] = {
      mediaConvertJobId: job.Job.Id,
      status: 'PROCESSING',
      created: new Date().toISOString()
    };
    
    res.json({
      success: true,
      jobId,
      status: 'processing'
    });
  } catch (error) {
    console.error('Error creating job:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Endpoint to check job status
app.get('/status/:jobId', async (req, res) => {
  const { jobId } = req.params;
  
  console.log(`Checking status for job: ${jobId}`);
  
  if (!jobsDB[jobId]) {
    console.log(`Job not found: ${jobId}`);
    return res.status(404).json({
      success: false,
      error: 'Job not found'
    });
  }
  
  try {
    const mediaConvertJobId = jobsDB[jobId].mediaConvertJobId;
    console.log(`Fetching MediaConvert job: ${mediaConvertJobId}`);
    
    const jobResult = await mediaConvert.getJob({ Id: mediaConvertJobId }).promise();
    const status = jobResult.Job.Status;
    
    console.log(`Job status: ${status}`);
    
    if (status === 'COMPLETE') {
      // First check where MediaConvert has actually placed the file
      const jobOutputs = jobResult.Job.Settings.OutputGroups[0].Outputs;
      console.log(`Job output details:`, JSON.stringify(jobOutputs));
      
      // Get the destination that was used in the job
      const destination = jobResult.Job.Settings.OutputGroups[0].OutputGroupSettings.FileGroupSettings.Destination;
      console.log(`Job destination: ${destination}`);
      
      // Generate public URL for the output
      // The correct output path might be different - this is what we need to verify
      const outputKey = `outputs/${jobId}.mp4`;
      console.log(`Checking for file at key: ${outputKey}`);
      
      // List the objects in the output folder to find the actual file
      const listParams = {
        Bucket: process.env.S3_BUCKET,
        Prefix: 'outputs/'
      };
      
      const listedObjects = await s3.listObjectsV2(listParams).promise();
      console.log(`Found ${listedObjects.Contents.length} objects in outputs folder`);
      
      // Find objects that might match our job
      const matchingObjects = listedObjects.Contents.filter(obj => 
        obj.Key.includes(jobId) || obj.Key.includes(jobId.replace(/-/g, ''))
      );
      
      console.log(`Found ${matchingObjects.length} objects matching job ID`);
      matchingObjects.forEach(obj => console.log(`- ${obj.Key}`));
      
      // If we found a matching object, use that key
      let actualOutputKey = outputKey;
      if (matchingObjects.length > 0) {
        actualOutputKey = matchingObjects[0].Key;
        console.log(`Using actual file key: ${actualOutputKey}`);
      }
      
      // Generate a pre-signed URL that expires in 24 hours
      const signedUrlExpireSeconds = 24 * 60 * 60;
      const params = {
        Bucket: process.env.S3_BUCKET,
        Key: actualOutputKey,
        Expires: signedUrlExpireSeconds,
        ResponseContentDisposition: 'attachment; filename="quran-recitation-with-subtitles.mp4"',
        ResponseContentType: 'video/mp4'
      };
      
      const url = await s3.getSignedUrlPromise('getObject', params);
      
      // Update job status
      jobsDB[jobId].status = 'COMPLETE';
      jobsDB[jobId].outputUrl = url;
      
      console.log(`Job complete. Output URL: ${url}`);
      
      return res.json({
        success: true,
        status: 'complete',
        progress: 100,
        outputUrl: url
      });
    }
    
    let progress = 0;
    if (status === 'SUBMITTED') progress = 5;
    else if (status === 'PROGRESSING') progress = 50;
    
    res.json({
      success: true,
      status: status.toLowerCase(),
      progress
    });
  } catch (error) {
    console.error('Error checking job status:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Generate ASS subtitle file content
function generateASS(verses, preferences) {
  // Default values if preferences are not provided
  const offset = preferences.subtitleOffset || 0;
  const display = preferences.lang || preferences.display || 'both';
  const fontSize = preferences.fontSize === 'large' ? 30 : 
                  preferences.fontSize === 'small' ? 18 : 24; // medium default
  
  // Build ASS header
  let assContent = `[Script Info]
Title: Quran Recitation Subtitles
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: None
PlayResX: 1280
PlayResY: 720

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Arabic,Arial Unicode MS,${fontSize + 6},&H00FFFFFF,&H000000FF,&H00000000,&HC0000000,1,0,0,0,100,100,0,0,1,2,1,2,10,10,20,1
Style: Translation,Arial,${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&HC0000000,0,0,0,0,100,100,0,0,1,1.5,0.5,2,10,10,45,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  // Add dialog entries for each verse
  verses.forEach((verse, index) => {
    const startTime = (verse.startTime !== undefined ? verse.startTime : index * 5) + offset;
    const endTime = (verse.endTime !== undefined ? verse.endTime : (index + 1) * 5) + offset;
    
    // Format time for ASS (H:MM:SS.cc)
    const formatAssTime = (seconds) => {
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const secs = Math.floor(seconds % 60);
      const centiseconds = Math.floor((seconds % 1) * 100);
      
      return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`;
    };
    
    // Add Arabic text if needed
    if (display !== 'translation' && verse.arabic) {
      // Escape any special characters in the text
      const escapedArabic = verse.arabic
        .replace(/\\/g, '\\\\')
        .replace(/\{/g, '\\{')
        .replace(/\}/g, '\\}');
        
      assContent += `Dialogue: 0,${formatAssTime(startTime)},${formatAssTime(endTime)},Arabic,,0,0,0,,${escapedArabic}\n`;
    }
    
    // Add translation text if needed
    if (display !== 'arabic' && verse.translation) {
      // Determine where to position the translation (after Arabic if both are shown)
      let marginV = 20;
      if (display === 'both') {
        marginV = 70; // Push translation down if Arabic is also shown
      }
      
      // Format translation with line breaks for readability
      const formattedTranslation = formatTranslationText(verse.translation);
      
      assContent += `Dialogue: 0,${formatAssTime(startTime)},${formatAssTime(endTime)},Translation,,0,0,${marginV},,${formattedTranslation}\n`;
    }
  });
  
  return assContent;
}

// Format translation text with line breaks
function formatTranslationText(text) {
  if (!text) return '';
  
  // Escape any special characters in the text
  text = text
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}');
  
  // Break long lines
  const maxCharsPerLine = 50;
  const words = text.split(' ');
  const lines = [];
  let currentLine = '';
  
  for (const word of words) {
    if ((currentLine + word).length > maxCharsPerLine) {
      lines.push(currentLine.trim());
      currentLine = word + ' ';
    } else {
      currentLine += word + ' ';
    }
  }
  
  if (currentLine.trim()) {
    lines.push(currentLine.trim());
  }
  
  // Join lines with ASS line break marker
  return lines.join('\\N');
}

// Helper function to generate SRT content
function generateSRT(verses, preferences) {
  let srtContent = '';
  const offset = preferences.subtitleOffset || 0;
  const display = preferences.lang || preferences.display || 'both';
  
  verses.forEach((verse, index) => {
    const startTime = (verse.startTime !== undefined ? verse.startTime : index * 5) + offset;
    const endTime = (verse.endTime !== undefined ? verse.endTime : (index + 1) * 5) + offset;
    
    srtContent += `${index + 1}\n`;
    srtContent += `${formatSRTTime(startTime)} --> ${formatSRTTime(endTime)}\n`;
    
    if (display !== 'translation') {
      srtContent += `${verse.arabic || ''}\n`;
    }
    
    if (display !== 'arabic' && verse.translation) {
      srtContent += `${verse.translation}\n`;
    }
    
    srtContent += '\n';
  });
  
  return srtContent;
}

// Format time for SRT (00:00:00,000)
function formatSRTTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
}

// Create MediaConvert job parameters
// Create MediaConvert job parameters
function createMediaConvertParams(videoUrl, subtitleKey, outputKey, preferences) {
  // Configure subtitle styling based on preferences
  const fontSize = preferences.fontSize === 'large' ? 30 : 
                 preferences.fontSize === 'small' ? 18 : 24; // medium default
  
  // Determine subtitle type from file extension
  const isAssFormat = subtitleKey.endsWith('.ass');
  
  return {
    Role: process.env.MEDIACONVERT_ROLE_ARN,
    Settings: {
      Inputs: [
        {
          FileInput: videoUrl,
          AudioSelectors: {
            "Audio Selector 1": {
              DefaultSelection: "DEFAULT"
            }
          },
          CaptionSelectors: {
            "Captions": {
              SourceSettings: {
                SourceType: isAssFormat ? "ASS" : "SRT",
                FileSourceSettings: {
                  SourceFile: `s3://${process.env.S3_BUCKET}/${subtitleKey}`
                }
              }
            }
          }
        }
      ],
      OutputGroups: [
        {
          OutputGroupSettings: {
            Type: "FILE_GROUP_SETTINGS",
            FileGroupSettings: {
              Destination: `s3://${process.env.S3_BUCKET}/${outputKey}`
            }
          },
          Outputs: [
            {
              VideoDescription: {
                // Add width and height to ensure consistent video dimensions
                Width: 1280,
                Height: 720,
                CodecSettings: {
                  Codec: "H_264",
                  H264Settings: {
                    RateControlMode: "CBR",
                    Bitrate: 5000000
                  }
                }
              },
              AudioDescriptions: [
                {
                  AudioSourceName: "Audio Selector 1",
                  CodecSettings: {
                    Codec: "AAC",
                    AacSettings: {
                      Bitrate: 96000,
                      CodingMode: "CODING_MODE_2_0",
                      SampleRate: 48000
                    }
                  }
                }
              ],
              ContainerSettings: {
                Container: "MP4"
              },
              CaptionDescriptions: [
                {
                  CaptionSelectorName: "Captions",
                  DestinationType: "BURN_IN",
                  BurnInCaptionSettings: {
                    TextGridPosition: "BOTTOM_CENTER",
                    FontSize: fontSize,
                    FontColor: "WHITE",
                    FontOpacity: 100,
                    BackgroundColor: "BLACK", 
                    BackgroundOpacity: 80,      // Semi-transparent background
                    OutlineColor: "BLACK",
                    OutlineSize: 2,             // Add outline for better visibility
                    ShadowColor: "BLACK",
                    ShadowOpacity: 80,
                    ShadowXOffset: 2,
                    ShadowYOffset: 2,
                    StylePassthrough: "ENABLED", // Preserve styling if available
                    // Keep subtitles within safe margins
                    HorizontalPosition: 400,     // Horizontal centering (0-100%)
                    VerticalPosition: 90,        // Position from top (90% = near bottom)
                    TeletextSpacing: "AUTO",     // Auto spacing
                    Width: 80                    // Width as percentage of video width (80%)
                  }
                }
              ]
            }
          ]
        }
      ]
    }
  };
}

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
