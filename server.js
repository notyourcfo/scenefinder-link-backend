const express = require('express');
const { OpenAI } = require('openai');
const cors = require('cors');
const ytdl = require('@distube/ytdl-core');
const { instagramGetUrl } = require('instagram-url-direct');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

require('dotenv').config();

const app = express();

// Initialize OpenAI client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Middleware
app.use(cors());
app.use(express.json());

// Ensure uploads directory exists
const uploadDir = path.join(__dirname, 'Uploads');
try {
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
} catch (error) {
  console.error('Failed to create uploads directory:', error);
  process.exit(1);
}

// Retry function for handling 429 and 401 errors
async function withRetry(fn, retries = 5, initialDelay = 10000) {
  let delay = initialDelay;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if ((error.statusCode === 429 || error.statusCode === 401) && i < retries - 1) {
        console.log(`Error ${error.statusCode}, retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2; // Exponential backoff
      } else {
        throw error;
      }
    }
  }
}

// Health check endpoint
app.get('/', (req, res) => {
  res.status(200).json({ status: 'OK', message: 'SceneFinder link backend is running' });
});

// Analyze link endpoint
app.post('/api/analyze-link', async (req, res) => {
  let audioPath;
  try {
    const { url } = req.body;
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'Invalid or missing URL' });
    }

    audioPath = path.join(uploadDir, `temp-${Date.now()}.mp3`);

    // Check available disk space
    try {
      const stats = fs.statfsSync(uploadDir);
      const freeMB = (stats.bavail * stats.bsize) / (1024 * 1024);
      if (freeMB < 50) {
        console.warn(`Low disk space: ${freeMB.toFixed(2)} MB available`);
        return res.status(500).json({ error: 'Insufficient disk space for processing' });
      }
    } catch (error) {
      console.error('Failed to check disk space:', error);
    }

    // Identify platform and download audio
    if (ytdl.validateURL(url)) {
      // YouTube
      console.log('Processing YouTube URL:', url);
      try {
        await withRetry(async () => {
          const stream = ytdl(url, { filter: 'audioonly', quality: 'highestaudio' });
          const fileStream = fs.createWriteStream(audioPath);
          stream.pipe(fileStream);

          await new Promise((resolve, reject) => {
            fileStream.on('finish', resolve);
            fileStream.on('error', reject);
            stream.on('error', (err) => reject(err));
          });
        });
      } catch (error) {
        console.error('YouTube processing failed:', error);
        if (error.statusCode === 429) {
          return res.status(429).json({ error: 'YouTube rate limit exceeded. Please try again later.' });
        }
        return res.status(400).json({ error: 'Failed to process YouTube URL. Ensure it is a valid, public video.' });
      }
    } else if (url.includes('instagram.com')) {
      // Instagram
      console.log('Processing Instagram URL:', url);
      try {
        await withRetry(async () => {
          const response = await instagramGetUrl(url);
          console.log('Instagram response:', response);
          if (!response.results_number || !response.url_list?.[0]) {
            throw new Error('Invalid or inaccessible Instagram video URL');
          }
          const videoUrl = response.url_list[0];
          console.log('Instagram video URL:', videoUrl);
          const videoResponse = await axios.get(videoUrl, { responseType: 'stream', timeout: 30000 });

          const fileStream = fs.createWriteStream(audioPath);
          videoResponse.data.pipe(fileStream);

          await new Promise((resolve, reject) => {
            fileStream.on('finish', resolve);
            fileStream.on('error', reject);
          });
        });
      } catch (error) {
        console.error('Instagram URL processing failed:', error);
        return res.status(400).json({ error: 'Failed to process Instagram URL. Ensure it is a public video or reel.' });
      }
    } else {
      return res.status(400).json({ error: 'Unsupported URL. Only YouTube and Instagram links are supported.' });
    }

    // Verify audio file
    if (!fs.existsSync(audioPath) || fs.statSync(audioPath).size === 0) {
      console.error('Audio file is missing or empty:', audioPath);
      return res.status(500).json({ error: 'Failed to generate audio file' });
    }

    // Transcribe audio using Whisper
    console.log('Transcribing audio from:', audioPath);
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model: 'whisper-1',
    });

    // Query GPT-4o for scene details
    const prompt = `
      You are a movie analyst with expertise in identifying scenes from short video or audio clips. Given the following dialogue transcript, which may be fragmented, incomplete, or contain background noise, provide:
      - The name of the movie or series (or "Unknown" if not identifiable)
      - Season and episode number (if applicable, or null if not a series or unknown)
      - Character names involved (or "Unknown" if not identifiable)
      - Approximate timestamp of the scene (if identifiable, or "Unknown")
      - A short context or summary of the scene (or a best guess based on available information)
      If the transcript is unclear or lacks sufficient dialogue, make an educated guess based on context clues or indicate uncertainty. Return the response in JSON format.

      Transcript:
      ${transcription.text}
    `;

    const gptResponse = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
    });

    const sceneDetails = JSON.parse(gptResponse.choices[0].message.content);

    res.status(200).json({
      success: true,
      data: sceneDetails,
    });
  } catch (error) {
    console.error('Error processing link:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  } finally {
    // Clean up temporary file
    if (audioPath && fs.existsSync(audioPath)) {
      try {
        fs.unlinkSync(audioPath);
        console.log('Cleaned up:', audioPath);
      } catch (error) {
        console.error('Failed to delete temporary file:', error);
      }
    }
  }
});

// Start server
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

module.exports = app;