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
    
    // Create SRT file from verses
    const srtContent = generateSRT(verses, { ...subtitlePreferences, subtitleOffset: subtitleOffset || 0 });
    console.log('Generated SRT content');
    
    // Upload SRT to S3
    const srtKey = `subtitles/${jobId}.srt`;
    console.log(`Uploading SRT to S3: ${srtKey}`);
    
    await s3.putObject({
      Bucket: process.env.S3_BUCKET,
      Key: srtKey,
      Body: srtContent,
      ContentType: 'text/plain'
    }).promise();
    
    console.log('SRT file uploaded successfully');
    
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
    const params = createMediaConvertParams(s3VideoUrl, srtKey, outputKey, subtitlePreferences || {});
    
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
      // Generate a pre-signed URL for the output that expires in 24 hours
      const signedUrlExpireSeconds = 24 * 60 * 60;
      const params = {
        Bucket: process.env.S3_BUCKET,
        Key: `outputs/${jobId}.mp4`,
        Expires: signedUrlExpireSeconds,
        ResponseContentDisposition: 'attachment; filename="quran-recitation-with-subtitles.mp4"',
        ResponseContentType: 'video/mp4'
      };
      
      const url = await s3.getSignedUrlPromise('getObject', params);
      
      // Update job status
      jobsDB[jobId].status = 'COMPLETE';
      jobsDB[jobId].outputUrl = url;
      
      console.log(`Job complete. Signed URL generated.`);
      
      return res.json({
        success: true,
        status: 'complete',
        progress: 100,
        outputUrl: url
      });
    } else if (status === 'ERROR') {
      // Get the error details
      const errorMessage = jobResult.Job.ErrorMessage || 'Unknown error';
      console.error(`Job error: ${errorMessage}`);
      
      return res.json({
        success: false,
        status: 'failed',
        error: errorMessage
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
function createMediaConvertParams(videoUrl, srtKey, outputKey, preferences) {
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
                SourceType: "SRT",
                FileSourceSettings: {
                  SourceFile: `s3://${process.env.S3_BUCKET}/${srtKey}`
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
