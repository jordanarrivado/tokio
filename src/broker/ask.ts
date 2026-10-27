import { spawn } from 'node:child_process';
import type { CatalogRepo } from './catalog';

/**
 * ask_repo: a one-shot, read-only agent run inside another catalog repository. It is how an agent
 * without SendMessage, such as Codex, reaches another repository's agent. The answering agent loads
 * that repository's own instructions and hooks, so it answers as that repository's agent would.
 */

export const ASK_TIMEOUT_MS = 180_000;
/** Answers past this are cut, so one question cannot flood the asking agent's context. */
export const MAX_ANSWER_CHARS = 6000;

/**
 * Claude Code in print mode. Print mode cannot ask for permission, and the edit and shell tools are
 * denied outright, so the run can read the repository but never change it.
 */
export const ANSWER_AGENT = {
  command: 'claude',
  args: [
    '-p',
    '--output-format', 'json',
    '--disallowedTools', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell'
  ]
} as const;

/** The prompt the answering agent gets. The question goes on stdin, never on the command line. */
export function buildAskPrompt(peer: CatalogRepo, from: string, question: string): string {
  return [
    `You are the agent for the ${peer.name} repository. The agent working in ${from} asks the question below.`,
    'Answer from this repository\'s code, config, and docs. Do not edit anything.',
    'Keep the answer short, cite files as path:line, and say plainly when the repository does not show the answer.',
    `End with one line of feedback for the ${from} agent: what would have made the question easier to answer.`,
    '',
    '<question>',
    question,
    '</question>'
  ].join('\n');
}

/** The answer text from Claude Code's JSON result, or an error message when the run failed. */
export function parseAnswer(stdout: string): { text: string; isError: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    const text = stdout.trim();
    return text === '' ? { text: 'The answering agent returned nothing.', isError: true } : { text, isError: false };
  }
  const record = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const result = typeof record.result === 'string' ? record.result.trim() : '';
  if (record.is_error === true || result === '') {
    return { text: result || 'The answering agent returned no answer.', isError: true };
  }
  return { text: result, isError: false };
}

export interface AgentProcess {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/** Runs the agent in cwd with the prompt on stdin. Aborting the signal kills it. */
export function runAnswerAgent(cwd: string, prompt: string, signal: AbortSignal): Promise<AgentProcess> {
  return new Promise((resolve, reject) => {
    // npm installs claude as a .cmd shim on Windows, which spawns only through a shell. The shell gets
    // fixed flags only; the question travels on stdin.
    const child = process.platform === 'win32'
      ? spawn([ANSWER_AGENT.command, ...ANSWER_AGENT.args].join(' '), { shell: true, cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      : spawn(ANSWER_AGENT.command, [...ANSWER_AGENT.args], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const kill = (): void => {
      // On Windows the child is the shell, so the agent under it is killed with its process tree.
      if (process.platform === 'win32' && child.pid !== undefined) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } else {
        child.kill();
      }
    };
    signal.addEventListener('abort', kill, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.on('error', () => undefined);
    child.on('error', (error) => {
      signal.removeEventListener('abort', kill);
      reject(new Error(`Could not start "${ANSWER_AGENT.command}": ${error.message}. Install Claude Code, or message the repository's open session instead.`));
    });
    child.on('close', (exitCode) => {
      signal.removeEventListener('abort', kill);
      resolve({ stdout, stderr, exitCode });
    });
    child.stdin.end(prompt);
  });
}
