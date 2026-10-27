import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';

/** Titles and the last prompt are re-appended as they change, so the end of the file has the latest. */
const TAIL_BYTES = 256 * 1024;
/** How far into a file to look for its first prompt. */
const MAX_HEAD_LINES = 2000;
/** Claude Code writes a conversation's title right after its first prompt, near the top. */
const TITLE_HEAD_BYTES = 64 * 1024;

/** A Claude conversation found in Claude Code's transcripts. */
export interface Conversation {
  /** The Claude session id: the transcript's file name. */
  id: string;
  file: string;
  /** Where it ran; resuming must run there to find the conversation. */
  cwd: string;
  title: string;
  /** 'custom' titles came from /rename. */
  titleSource: 'custom' | 'ai' | 'prompt';
  firstPrompt?: string;
  lastPrompt?: string;
  gitBranch?: string;
  /** The transcript's mtime. */
  lastActive: number;
  /** Set while a Claude process has this conversation open. */
  running?: RunningProcess;
}

export interface RunningProcess {
  pid: number;
  status?: string;
}

/** The folder Claude Code keeps a directory's transcripts in: every non-alphanumeric character becomes `-`. */
export function projectDirName(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Reads conversations from Claude Code's files: transcripts in `~/.claude/projects/<folder>/`
 * and running processes in `~/.claude/sessions/<pid>.json`. Neither format is documented, so
 * anything unexpected is skipped. Only ever reads.
 */
export class TranscriptIndex {
  /** Parsed transcripts by path, kept while their mtime and size are unchanged. */
  private readonly cache = new Map<string, { mtimeMs: number; size: number; conversation: Conversation | undefined }>();

  constructor(
    readonly projectsDir = path.join(os.homedir(), '.claude', 'projects'),
    readonly sessionsDir = path.join(os.homedir(), '.claude', 'sessions'),
  ) {}

  /** Project folders that can hold conversations run in `dir` or below it. */
  projectDirsFor(dir: string): string[] {
    const name = projectDirName(dir);
    try {
      return fs
        .readdirSync(this.projectsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && (entry.name === name || entry.name.startsWith(name + '-')))
        .map((entry) => path.join(this.projectsDir, entry.name));
    } catch {
      return [];
    }
  }

  /**
   * Up to `limit` conversations, newest first, whose cwd is in `dir`'s folder group
   * (`belongs(cwd)`), skipping ids `skip` rejects before their files are read.
   */
  async list(
    dir: string,
    limit: number,
    belongs: (cwd: string) => boolean,
    skip: (id: string) => boolean,
  ): Promise<Conversation[]> {
    const files: { file: string; id: string; stat: fs.Stats }[] = [];
    for (const projectDir of this.projectDirsFor(dir)) {
      let names: string[];
      try {
        names = fs.readdirSync(projectDir);
      } catch {
        continue;
      }
      // Subagents' transcripts are in subfolders; only top-level files are conversations.
      for (const name of names) {
        const id = name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : undefined;
        if (!id || skip(id)) {
          continue;
        }
        const file = path.join(projectDir, name);
        try {
          files.push({ file, id, stat: fs.statSync(file) });
        } catch {
          // Deleted since the listing.
        }
      }
    }
    files.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    const running = this.running();
    const result: Conversation[] = [];
    for (const { file, id, stat } of files) {
      if (result.length >= limit) {
        break;
      }
      const conversation = await this.read(file, id, stat);
      if (conversation && belongs(conversation.cwd)) {
        result.push({ ...conversation, running: running.get(id) });
      }
    }
    return result;
  }

  /** When the conversation `id`, run in `cwd`, was last written to; undefined if its transcript isn't there. */
  lastActive(cwd: string, id: string): number | undefined {
    try {
      return fs.statSync(path.join(this.projectsDir, projectDirName(cwd), `${id}.jsonl`)).mtimeMs;
    } catch {
      return undefined;
    }
  }

  /** Running Claude processes by the conversation they have open. */
  running(): Map<string, RunningProcess> {
    const result = new Map<string, RunningProcess>();
    let names: string[];
    try {
      names = fs.readdirSync(this.sessionsDir);
    } catch {
      return result;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) {
        continue;
      }
      try {
        const entry = JSON.parse(fs.readFileSync(path.join(this.sessionsDir, name), 'utf8'));
        if (typeof entry.pid === 'number' && typeof entry.sessionId === 'string' && isProcessAlive(entry.pid)) {
          result.set(entry.sessionId, { pid: entry.pid, status: typeof entry.status === 'string' ? entry.status : undefined });
        }
      } catch {
        // Mid-write or not a registry entry.
      }
    }
    return result;
  }

  private async read(file: string, id: string, stat: fs.Stats): Promise<Conversation | undefined> {
    const cached = this.cache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.conversation;
    }
    let conversation: Conversation | undefined;
    try {
      conversation = await parseTranscript(file, id, stat);
    } catch {
      conversation = undefined;
    }
    this.cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, conversation });
    return conversation;
  }
}

type Line = Record<string, unknown>;

/**
 * The title Claude Code generated for a conversation (`ai-title`), from the start of its
 * transcript; undefined if it isn't there yet or the file can't be read.
 */
export async function readAiTitle(file: string): Promise<string | undefined> {
  let text: string;
  try {
    const handle = await fs.promises.open(file, 'r');
    try {
      const buffer = Buffer.alloc(TITLE_HEAD_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      text = buffer.toString('utf8', 0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
  let title: string | undefined;
  // A partial last line just fails to parse.
  for (const line of text.split('\n').map(parse)) {
    if (line?.type === 'ai-title') {
      title = stringOf(line.aiTitle) ?? title;
    }
  }
  return title?.trim() || undefined;
}

/**
 * A conversation from its transcript: cwd, entrypoint and first prompt from the start, titles
 * and the last prompt from the end. Undefined for `-p` runs (entrypoint `sdk-*`) and
 * transcripts with no prompt.
 */
async function parseTranscript(file: string, id: string, stat: fs.Stats): Promise<Conversation | undefined> {
  let cwd: string | undefined;
  let entrypoint: string | undefined;
  let firstPrompt: string | undefined;
  let gitBranch: string | undefined;
  const lines = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  let count = 0;
  for await (const text of lines) {
    if (++count > MAX_HEAD_LINES) {
      break;
    }
    const line = parse(text);
    if (line?.type !== 'user') {
      continue;
    }
    cwd ??= stringOf(line.cwd);
    entrypoint ??= stringOf(line.entrypoint);
    gitBranch ??= stringOf(line.gitBranch);
    firstPrompt ??= promptOf(line);
    if (cwd && firstPrompt) {
      break;
    }
  }
  lines.close();
  if (!cwd || !firstPrompt || entrypoint?.startsWith('sdk')) {
    return undefined;
  }

  let customTitle: string | undefined;
  let aiTitle: string | undefined;
  let lastPrompt: string | undefined;
  for (const line of await tailLines(file, stat.size)) {
    if (line.type === 'custom-title') {
      customTitle = stringOf(line.customTitle) ?? customTitle;
    } else if (line.type === 'ai-title') {
      aiTitle = stringOf(line.aiTitle) ?? aiTitle;
    } else if (line.type === 'summary') {
      aiTitle = stringOf(line.summary) ?? aiTitle;
    } else if (line.type === 'last-prompt') {
      lastPrompt = stringOf(line.lastPrompt) ?? lastPrompt;
    }
    gitBranch = stringOf(line.gitBranch) ?? gitBranch;
  }
  const [title, titleSource]: [string, Conversation['titleSource']] = customTitle
    ? [customTitle, 'custom']
    : aiTitle
      ? [aiTitle, 'ai']
      : [firstLine(firstPrompt), 'prompt'];
  return { id, file, cwd, title, titleSource, firstPrompt, lastPrompt, gitBranch, lastActive: stat.mtimeMs };
}

/** The parsed lines in the last TAIL_BYTES of a file, without the first (probably partial) one. */
async function tailLines(file: string, size: number): Promise<Line[]> {
  const start = Math.max(0, size - TAIL_BYTES);
  const handle = await fs.promises.open(file, 'r');
  try {
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const texts = buffer.toString('utf8').split('\n');
    return (start > 0 ? texts.slice(1) : texts).map(parse).filter((line): line is Line => !!line);
  } finally {
    await handle.close();
  }
}

/** A prompt you typed: not tool results, injected context, or slash-command output. */
function promptOf(line: Line): string | undefined {
  if (line.isMeta || line.isCompactSummary || line.isSidechain) {
    return undefined;
  }
  const content = (line.message as { content?: unknown } | undefined)?.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .filter((part) => part?.type === 'text' && typeof part.text === 'string')
            .map((part) => part.text as string)
            .join('\n')
        : '';
  const trimmed = text.trim();
  // Slash commands and their output are logged as XML-ish wrappers.
  return trimmed && !trimmed.startsWith('<') ? trimmed : undefined;
}

function parse(text: string): Line | undefined {
  if (!text.trim()) {
    return undefined;
  }
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : undefined;
  } catch {
    return undefined;
  }
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function firstLine(text: string): string {
  return text.split('\n').map((line) => line.trim()).find(Boolean) ?? text;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: alive but owned by someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
