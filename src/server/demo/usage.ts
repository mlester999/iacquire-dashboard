import "server-only";
import type { Queryable } from "@/server/db";
import { dayOf } from "@/server/demo/core";

// The platform's daily counters for the demo (UTC day): demos started, AI messages taken from the day's budget, and messages refused because the budget was used up. The
// platform pays for every AI message, so the ceiling is taken in the database, in the same transaction that counts the prospect's message, and a refusal costs nothing. A cap of
// 0 stops the thing it caps.

export interface DemoUsageDay {
  day: string;
  starts: number;
  messages: number;
  blocked: number;
}

/** Takes one demo start from today's places. False when none are left. */
export async function takeStart(db: Queryable, now: Date, cap: number): Promise<boolean> {
  if (cap <= 0) return false;
  const { rows } = await db.query(
    `insert into demo_usage_days (day, starts) values ($1::date, 1)
     on conflict (day) do update set starts = demo_usage_days.starts + 1, updated_at = now() where demo_usage_days.starts < $2
     returning starts`,
    [dayOf(now), cap],
  );
  return rows.length > 0;
}

/** Whether today still has places, without taking one. */
export async function startsLeft(db: Queryable, now: Date, cap: number): Promise<boolean> {
  if (cap <= 0) return false;
  const { rows } = await db.query<{ starts: number }>("select starts from demo_usage_days where day = $1::date", [dayOf(now)]);
  return (rows[0]?.starts ?? 0) < cap;
}

/** Takes one AI message from today's budget. False when the budget is used up. */
export async function takeMessage(db: Queryable, now: Date, cap: number): Promise<boolean> {
  if (cap <= 0) return false;
  const { rows } = await db.query(
    `insert into demo_usage_days (day, messages) values ($1::date, 1)
     on conflict (day) do update set messages = demo_usage_days.messages + 1, updated_at = now() where demo_usage_days.messages < $2
     returning messages`,
    [dayOf(now), cap],
  );
  return rows.length > 0;
}

/** Gives a message back to the day it was taken from (the model was never asked). */
export async function giveMessageBack(db: Queryable, day: string): Promise<void> {
  await db.query("update demo_usage_days set messages = greatest(messages - 1, 0), updated_at = now() where day = $1::date", [day]);
}

/** Counts a message that was refused because the day's budget was used up. */
export async function countRefused(db: Queryable, now: Date): Promise<number> {
  const { rows } = await db.query<{ blocked: number }>(
    `insert into demo_usage_days (day, blocked) values ($1::date, 1)
     on conflict (day) do update set blocked = demo_usage_days.blocked + 1, updated_at = now() returning blocked`,
    [dayOf(now)],
  );
  return rows[0]?.blocked ?? 1;
}

export async function usageToday(db: Queryable, now: Date): Promise<DemoUsageDay> {
  const { rows } = await db.query<{ starts: number; messages: number; blocked: number }>("select starts, messages, blocked from demo_usage_days where day = $1::date", [dayOf(now)]);
  return { day: dayOf(now), starts: rows[0]?.starts ?? 0, messages: rows[0]?.messages ?? 0, blocked: rows[0]?.blocked ?? 0 };
}
