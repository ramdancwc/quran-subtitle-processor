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
    
    // Generate TTML content for better Arabic support
    const ttmlContent = generateTTML(verses, { ...subtitlePreferences, subtitleOffset: subtitleOffset || 0 });
    console.log('Generated TTML content');
    
    // Upload TTML to S3
    const ttmlKey = `subtitles/${jobId}.ttml`;
    console.log(`Uploading TTML to S3: ${ttmlKey}`);
    
    await s3.putObject({
      Bucket: process.env.S3_BUCKET,
      Key: ttmlKey,
      Body: ttmlContent,
      ContentType: 'application/ttml+xml'
    }).promise();
    
    console.log('TTML file uploaded successfully');
    
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
    const params = createMediaConvertParams(s3VideoUrl, ttmlKey, outputKey, subtitlePreferences || {});
    
    console.log('Creating MediaConvert job...');
    console.log('Job parameters:', JSON.stringify(params, null, 2));
    
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

// Generate TTML subtitles with enhanced RTL support and improved layout for Arabic
function generateTTML(verses, preferences) {
  const offset = preferences.subtitleOffset || 0;
  const display = preferences.lang || preferences.display || 'both';
  const fontSize = preferences.fontSize === 'large' ? '120%' : 
                 preferences.fontSize === 'small' ? '80%' : '100%'; // medium default
  
  // Start the TTML document with appropriate namespaces and styling
  let ttmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" 
    xmlns:tts="http://www.w3.org/ns/ttml#styling"
    xmlns:ttm="http://www.w3.org/ns/ttml#metadata"
    xml:lang="en">
  <head>
    <metadata>
      <ttm:title>Quran Recitation Subtitles</ttm:title>
      <ttm:copyright>Generated by Quran Subtitle Processor</ttm:copyright>
    </metadata>
    <styling>
      <style xml:id="arabicStyle" 
             tts:fontFamily="Arial Unicode MS, Scheherazade, Amiri, serif" 
             tts:fontSize="${fontSize}" 
             tts:fontWeight="bold"
             tts:color="white"
             tts:backgroundColor="rgba(0,0,0,0.8)"
             tts:textAlign="center"
             tts:direction="rtl"
             tts:unicodeBidi="embed"
             tts:textOutline="black 1px"/>
      <style xml:id="translationStyle" 
             tts:fontFamily="Arial, sans-serif" 
             tts:fontSize="${fontSize}" 
             tts:color="white"
             tts:backgroundColor="rgba(0,0,0,0.8)"
             tts:textAlign="center"
             tts:direction="ltr"
             tts:textOutline="black 1px"/>
    </styling>
    <layout>
      <region xml:id="arabicRegion" 
              tts:displayAlign="center"
              tts:origin="10% 70%"
              tts:extent="80% 20%"/>
      <region xml:id="translationRegion" 
              tts:displayAlign="center"
              tts:origin="10% 90%"
              tts:extent="80% 20%"/>
    </layout>
  </head>
  <body>
    <div>
`;
  
  // Add each verse as a <p> element with appropriate timing and styling
  verses.forEach((verse, index) => {
    const startTime = (verse.startTime !== undefined ? verse.startTime : index * 5) + offset;
    const endTime = (verse.endTime !== undefined ? verse.endTime : (index + 1) * 5) + offset;
    
    // Format time for TTML (HH:MM:SS.sss)
    const formatTime = (seconds) => {
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const secs = Math.floor(seconds % 60);
      const ms = Math.floor((seconds % 1) * 1000);
      
      return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
    };
    
    const begin = formatTime(startTime);
    const end = formatTime(endTime);
    
    // Add Arabic text if needed
    if (display !== 'translation' && verse.arabic) {
      // Split long Arabic text to prevent overflow
      const arabicLines = splitLongText(verse.arabic, 40);
      
      if (arabicLines.length === 1) {
        // Single line, use the standard approach
        ttmlContent += `      <p xml:id="verse${index}a" begin="${begin}" end="${end}" region="arabicRegion" style="arabicStyle">${escapeXml(verse.arabic)}</p>\n`;
      } else {
        // Multiple lines needed, create spans with line breaks
        ttmlContent += `      <p xml:id="verse${index}a" begin="${begin}" end="${end}" region="arabicRegion" style="arabicStyle">`;
        arabicLines.forEach((line, i) => {
          ttmlContent += escapeXml(line);
          if (i < arabicLines.length - 1) {
            ttmlContent += '<br/>';
          }
        });
        ttmlContent += `</p>\n`;
      }
    }
    
    // Add translation if needed
    if (display !== 'arabic' && verse.translation) {
      // Split long translation to prevent overflow
      const translationLines = splitLongText(verse.translation, 50);
      
      if (translationLines.length === 1) {
        // Single line, use the standard approach
        ttmlContent += `      <p xml:id="verse${index}t" begin="${begin}" end="${end}" region="translationRegion" style="translationStyle">${escapeXml(verse.translation)}</p>\n`;
      } else {
        // Multiple lines needed, create spans with line breaks
        ttmlContent += `      <p xml:id="verse${index}t" begin="${begin}" end="${end}" region="translationRegion" style="translationStyle">`;
        translationLines.forEach((line, i) => {
          ttmlContent += escapeXml(line);
          if (i < translationLines.length - 1) {
            ttmlContent += '<br/>';
          }
        });
        ttmlContent += `</p>\n`;
      }
    }
  });
  
  // Close the TTML document
  ttmlContent += `    </div>
  </body>
</tt>`;
  
  return ttmlContent;
}

// Helper function to split long text into multiple lines
function splitLongText(text, maxCharsPerLine) {
  if (!text) return [];
  
  const words = text.split(' ');
  const lines = [];
  let currentLine = '';
  
  for (const word of words) {
    if ((currentLine + word).length > maxCharsPerLine) {
      if (currentLine) lines.push(currentLine.trim());
      currentLine = word + ' ';
    } else {
      currentLine += word + ' ';
    }
  }
  
  if (currentLine.trim()) {
    lines.push(currentLine.trim());
  }
  
  return lines;
}

// Helper function to escape XML special characters
function escapeXml(unsafe) {
  if (!unsafe) return '';
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Original helper function for backwards compatibility
function generateSRT(verses, preferences) {
  console.log('SRT format is not recommended for Arabic text. Using TTML instead.');
  return generateTTML(verses, preferences);
}

// Format time for SRT (00:00:00,000) - kept for compatibility
function formatSRTTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
}

// Create MediaConvert job parameters with TTML but no Style parameter
function createMediaConvertParams(videoUrl, ttmlKey, outputKey, preferences) {
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
                SourceType: "TTML",
                FileSourceSettings: {
                  SourceFile: `s3://${process.env.S3_BUCKET}/${ttmlKey}`
                }
              }
            }
          }
        }
      ],
      OutputGroups: [
        {
          Name: "File Group",
          OutputGroupSettings: {
            Type: "FILE_GROUP_SETTINGS",
            FileGroupSettings: {
              Destination: `s3://${process.env.S3_BUCKET}/${outputKey}`
            }
          },
          Outputs: [
            {
              VideoDescription: {
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
                  DestinationSettings: {
                    DestinationType: "BURN_IN"
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
