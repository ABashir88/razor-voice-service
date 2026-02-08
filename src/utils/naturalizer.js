/**
 * Naturalizer
 * Makes responses sound more human with fillers, contractions, and natural phrasing
 */

/**
 * Add natural starters randomly
 */
function addStarter(text) {
  // 25% chance to add a starter
  if (Math.random() > 0.25) return text;

  const starters = [
    "So, ",
    "Okay, ",
    "Alright, ",
    "Look, ",
    "Well, "
  ];

  const starter = starters[Math.floor(Math.random() * starters.length)];
  return starter + text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * Contract words naturally
 */
function addContractions(text) {
  const contractions = [
    [/\bdo not\b/gi, "don't"],
    [/\bcan not\b/gi, "can't"],
    [/\bcannot\b/gi, "can't"],
    [/\bwill not\b/gi, "won't"],
    [/\bit is\b/gi, "it's"],
    [/\bthat is\b/gi, "that's"],
    [/\bwhat is\b/gi, "what's"],
    [/\bI am\b/gi, "I'm"],
    [/\byou are\b/gi, "you're"],
    [/\bthey are\b/gi, "they're"],
    [/\bwe are\b/gi, "we're"],
    [/\bI have\b/gi, "I've"],
    [/\byou have\b/gi, "you've"],
    [/\bI would\b/gi, "I'd"],
    [/\byou would\b/gi, "you'd"],
    [/\bgoing to\b/gi, "gonna"],
    [/\bwant to\b/gi, "wanna"],
    [/\bgot to\b/gi, "gotta"]
  ];

  for (const [pattern, replacement] of contractions) {
    text = text.replace(pattern, replacement);
  }

  return text;
}

/**
 * Simplify numbers for speech
 */
function simplifyNumbers(text) {
  // $76,000 -> $76k
  text = text.replace(/\$(\d+),000\b/g, '$$1k');
  text = text.replace(/\$(\d+)000\b/g, '$$1k');

  // $76200 -> $76k (round)
  text = text.replace(/\$(\d+)(\d{3})\b/g, (match, thousands) => `$${thousands}k`);

  return text;
}

/**
 * Add conversational endings occasionally
 */
function addEnding(text) {
  // 20% chance to add an ending
  if (Math.random() > 0.20) return text;

  // Don't add if already ends with question or certain phrases
  if (text.endsWith('?') || text.endsWith('...')) return text;

  const endings = [
    " Want me to dig deeper?",
    " Need anything else?",
    " What do you think?",
    ""
  ];

  const ending = endings[Math.floor(Math.random() * endings.length)];

  // Make sure we don't double-punctuate
  if (ending && text.endsWith('.')) {
    text = text.slice(0, -1);
  }

  return text + ending;
}

/**
 * Main naturalizer function
 */
export function naturalize(text, options = {}) {
  if (!text) return text;

  const {
    addStarterEnabled = true,
    addContractionsEnabled = true,
    simplifyNumbersEnabled = true,
    addEndingEnabled = false  // Off by default, can be chatty
  } = options;

  if (simplifyNumbersEnabled) {
    text = simplifyNumbers(text);
  }

  if (addContractionsEnabled) {
    text = addContractions(text);
  }

  if (addStarterEnabled) {
    text = addStarter(text);
  }

  if (addEndingEnabled) {
    text = addEnding(text);
  }

  // Fix stray periods after numbers (e.g., "9. deals" -> "9 deals")
  text = text.replace(/(\d)\. ([a-z])/gi, '$1 $2');

  return text;
}

export default { naturalize };
