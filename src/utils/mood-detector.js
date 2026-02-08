/**
 * Mood Detection
 * Analyzes user input to detect emotional state
 */

import makeLogger from './logger.js';
const log = makeLogger('Mood');

const MOOD_PATTERNS = {
  frustrated: {
    patterns: [
      /\b(ugh|argh|damn|crap|cmon|shit|fuck|dammit)\b/i,
      /\b(killing me|frustrat|annoy|hate this|sick of|tired of)\b/i,
      /\b(not working|broken|stuck|impossible)\b/i
    ],
    weight: 1.0
  },
  stressed: {
    patterns: [
      /\b(worried|nervous|anxious|stressed|pressure|deadline)\b/i,
      /\b(behind|quota|target|gonna miss|not gonna make)\b/i,
      /\b(help|need to|have to|must|urgent)\b/i
    ],
    weight: 0.8
  },
  excited: {
    patterns: [
      /\b(yes|yeah|awesome|amazing|perfect|great|nice|love it)\b/i,
      /\b(let's go|hell yeah|woo|finally|nailed it)\b/i,
      /!{2,}/  // Multiple exclamation marks
    ],
    weight: 1.0
  },
  curious: {
    patterns: [
      /\b(what about|how about|tell me|show me|what's|what is)\b/i,
      /\b(wondering|curious|interested)\b/i,
      /\?$/  // Ends with question mark
    ],
    weight: 0.5
  },
  casual: {
    patterns: [
      /^(hey|hi|yo|sup|what's up|how's it going)/i,
      /\b(just checking|quick question|real quick)\b/i
    ],
    weight: 0.5
  },
  tired: {
    patterns: [
      /\b(tired|exhausted|long day|ugh monday|mondays)\b/i,
      /\b(need coffee|barely awake|so done)\b/i
    ],
    weight: 0.7
  }
};

/**
 * Detect mood from transcript
 * @param {string} transcript - User's spoken input
 * @returns {object} - { mood: string, confidence: number }
 */
export function detectMood(transcript) {
  let detectedMood = 'neutral';
  let highestScore = 0;

  for (const [mood, config] of Object.entries(MOOD_PATTERNS)) {
    let score = 0;

    for (const pattern of config.patterns) {
      if (pattern.test(transcript)) {
        score += config.weight;
      }
    }

    if (score > highestScore) {
      highestScore = score;
      detectedMood = mood;
    }
  }

  // Need at least some confidence to override neutral
  if (highestScore < 0.5) {
    detectedMood = 'neutral';
  }

  log.debug(`Detected: ${detectedMood} (score: ${highestScore})`);

  return {
    mood: detectedMood,
    confidence: Math.min(highestScore, 1.0)
  };
}

/**
 * Get response prefix based on mood
 */
export function getMoodPrefix(mood) {
  const prefixes = {
    frustrated: [
      "I hear you. ",
      "Yeah, that's rough. ",
      "Okay, let's fix this. ",
      ""
    ],
    stressed: [
      "Hey, you've got this. ",
      "Deep breath. ",
      "Let's tackle it. ",
      ""
    ],
    excited: [
      "Hell yeah! ",
      "Nice! ",
      "Love it. ",
      "Let's go! "
    ],
    curious: [
      "",
      "Good question. ",
      ""
    ],
    casual: [
      "Hey. ",
      "Yo. ",
      "",
      ""
    ],
    tired: [
      "I feel you. ",
      "Hang in there. ",
      ""
    ],
    neutral: [""]
  };

  const options = prefixes[mood] || prefixes.neutral;
  return options[Math.floor(Math.random() * options.length)];
}

/**
 * Get TTS parameters based on mood
 */
export function getMoodTTSParams(mood) {
  // Pace values must match config.pacing keys: 'urgent', 'normal', 'calm'
  const params = {
    frustrated: { pace: 'calm' },
    stressed: { pace: 'calm' },
    excited: { pace: 'urgent' },
    curious: { pace: 'normal' },
    casual: { pace: 'normal' },
    tired: { pace: 'calm' },
    neutral: { pace: 'normal' }
  };

  return params[mood] || params.neutral;
}

export default { detectMood, getMoodPrefix, getMoodTTSParams };
