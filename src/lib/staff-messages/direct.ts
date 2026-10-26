// The key of a direct message: the two people's ids, lower case, sorted and joined by a colon, so there is one direct message per pair whoever opens it first. Pure.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isUserId = (value: unknown): value is string => typeof value === "string" && UUID.test(value.toLowerCase());

/** Plain code-unit order, which for these lower-case ids is the order the database check (collate "C") expects. */
export function directKey(a: string, b: string): string {
  if (!isUserId(a) || !isUserId(b)) throw new Error("A direct message needs two valid person ids.");
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  if (x === y) throw new Error("A direct message needs two different people.");
  return x < y ? `${x}:${y}` : `${y}:${x}`;
}

/** The two ids in a key, or null when the text is not a key this module made. */
export function parseDirectKey(key: string): [string, string] | null {
  const parts = key.split(":");
  if (parts.length !== 2 || !isUserId(parts[0]) || !isUserId(parts[1]) || parts[0] >= parts[1] || parts[0] !== parts[0].toLowerCase() || parts[1] !== parts[1].toLowerCase()) return null;
  return [parts[0], parts[1]];
}

/** The other person of a direct message, or null when `me` is not one of the two. */
export function peerOf(key: string, me: string): string | null {
  const pair = parseDirectKey(key);
  const mine = me.toLowerCase();
  if (!pair || (pair[0] !== mine && pair[1] !== mine)) return null;
  return pair[0] === mine ? pair[1] : pair[0];
}
