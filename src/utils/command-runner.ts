import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(command: string, args?: readonly string[], options?: CommandRunOptions): Promise<CommandResult>;
}

export interface CommandRunOptions {
  timeoutMs?: number;
  maxBuffer?: number;
}

export const defaultCommandRunner: CommandRunner = {
  async run(command, args = [], options = {}) {
    const result = await execFileAsync(command, [...args], {
      timeout: options.timeoutMs ?? 5_000,
      maxBuffer: options.maxBuffer ?? 1024 * 1024,
      windowsHide: true,
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
    };
  },
};
