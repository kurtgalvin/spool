const MAX_LENGTH = 32;

/** Derives a short session name from a prompt, or undefined if the prompt isn't a good name. */
export function nameFromPrompt(prompt: unknown): string | undefined {
  if (typeof prompt !== 'string') {
    return undefined;
  }
  const firstLine = prompt.split('\n').map((line) => line.trim()).find(Boolean);
  // Slash commands (/model, /clear) and shell escapes say nothing about the session's topic.
  if (!firstLine || firstLine.startsWith('/') || firstLine.startsWith('!')) {
    return undefined;
  }
  const text = firstLine.replace(/\s+/g, ' ');
  if (text.length <= MAX_LENGTH) {
    return text;
  }
  const cut = text.slice(0, MAX_LENGTH);
  const lastSpace = cut.lastIndexOf(' ');
  // Break at a word boundary unless that would throw away most of the text.
  return `${lastSpace > MAX_LENGTH / 2 ? cut.slice(0, lastSpace) : cut}…`;
}
