import { promises as fs } from "node:fs";

// Linux x86_64 struct utmp layout (384 bytes)
const UTMP_RECORD_SIZE = 384;
const UT_TYPE_BOOT_TIME = 2;
const UT_TYPE_USER_PROCESS = 7;
const UT_TYPE_DEAD_PROCESS = 8;

const OFFSET = {
  type: 0,
  pid: 4,
  line: 8,
  id: 40,
  user: 44,
  host: 76,
  tv_sec: 340,
  addr_v6: 348,
} as const;

const SIZE = {
  line: 32,
  user: 32,
  host: 256,
} as const;

export interface UtmpEntry {
  user: string;
  terminal: string;
  host: string;
  ip: string;
  loginAt: Date;
}

export async function readLoggedInUsers(path = "/var/run/utmp"): Promise<UtmpEntry[]> {
  const buf = await fs.readFile(path);
  const entries: UtmpEntry[] = [];

  for (let offset = 0; offset + UTMP_RECORD_SIZE <= buf.length; offset += UTMP_RECORD_SIZE) {
    const type = buf.readInt16LE(offset + OFFSET.type);
    if (type !== UT_TYPE_USER_PROCESS) continue;

    const user = readCString(buf, offset + OFFSET.user, SIZE.user);
    if (!user) continue;

    const terminal = readCString(buf, offset + OFFSET.line, SIZE.line);
    const host = readCString(buf, offset + OFFSET.host, SIZE.host);
    const tvSec = buf.readInt32LE(offset + OFFSET.tv_sec);
    const ip = readIPv4(buf, offset + OFFSET.addr_v6);

    entries.push({
      user,
      terminal,
      host,
      ip,
      loginAt: new Date(tvSec * 1000),
    });
  }

  return entries;
}

function readCString(buf: Buffer, offset: number, maxLen: number): string {
  let end = offset;
  const limit = offset + maxLen;
  while (end < limit && buf[end] !== 0) end += 1;
  return buf.toString("utf-8", offset, end);
}

function readIPv4(buf: Buffer, offset: number): string {
  const a = buf[offset];
  const b = buf[offset + 1];
  const c = buf[offset + 2];
  const d = buf[offset + 3];
  if (a === 0 && b === 0 && c === 0 && d === 0) return "";
  return `${a}.${b}.${c}.${d}`;
}

export type SessionEndReason = "logout" | "crash" | "shutdown" | "reboot";

export interface LoginSession {
  user: string;
  terminal: string;
  host: string;
  startTime: Date;
  endTime: Date | null;
  durationSeconds: number | null;
  active: boolean;
  endReason?: SessionEndReason;
}

// wtmp shares utmp's on-disk record layout. USER_PROCESS = login,
// DEAD_PROCESS = logout (matched by terminal/line). BOOT_TIME closes any
// still-open session as a crash boundary.
export async function readWtmpSessions(path = "/var/log/wtmp"): Promise<LoginSession[]> {
  const buf = await fs.readFile(path);
  const sessions: LoginSession[] = [];
  const openByLine = new Map<string, LoginSession>();

  const closeOpen = (session: LoginSession, endTime: Date, reason: SessionEndReason) => {
    session.endTime = endTime;
    session.durationSeconds = Math.max(
      0,
      Math.round((endTime.getTime() - session.startTime.getTime()) / 1000),
    );
    session.endReason = reason;
    sessions.push(session);
  };

  for (let offset = 0; offset + UTMP_RECORD_SIZE <= buf.length; offset += UTMP_RECORD_SIZE) {
    const type = buf.readInt16LE(offset + OFFSET.type);
    const terminal = readCString(buf, offset + OFFSET.line, SIZE.line);
    const tvSec = buf.readInt32LE(offset + OFFSET.tv_sec);
    const time = new Date(tvSec * 1000);

    if (type === UT_TYPE_USER_PROCESS) {
      const user = readCString(buf, offset + OFFSET.user, SIZE.user);
      if (!user) continue;
      // Orphan previous session on the same line (defensive; normally DEAD_PROCESS closes).
      const existing = openByLine.get(terminal);
      if (existing) closeOpen(existing, time, "crash");

      openByLine.set(terminal, {
        user,
        terminal,
        host: readCString(buf, offset + OFFSET.host, SIZE.host),
        startTime: time,
        endTime: null,
        durationSeconds: null,
        active: false,
      });
    } else if (type === UT_TYPE_DEAD_PROCESS) {
      const session = openByLine.get(terminal);
      if (!session) continue;
      closeOpen(session, time, "logout");
      openByLine.delete(terminal);
    } else if (type === UT_TYPE_BOOT_TIME) {
      for (const session of openByLine.values()) {
        closeOpen(session, time, "crash");
      }
      openByLine.clear();
    }
  }

  // Whatever stays open at EOF is actively logged in.
  for (const session of openByLine.values()) {
    session.active = true;
    sessions.push(session);
  }

  sessions.sort((a, b) => b.startTime.getTime() - a.startTime.getTime());
  return sessions;
}
