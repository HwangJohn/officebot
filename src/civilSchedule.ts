const DAY = 86_400_000;
const MINUTE = 60_000;
export type CivilSchedule = { timeZone: string; minuteOfDay: number; weekday?: number };
type Pattern = CivilSchedule & { recurrence: 'daily' | 'weekly'; weekday: number };
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string) {
  let result = formatters.get(zone);
  if (!result) {
    result = new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    if (formatters.size >= 64) formatters.delete(formatters.keys().next().value!);
    formatters.set(zone, result);
  }
  return result;
}
function localStamp(epoch: number, zone: string) {
  const parts = formatter(zone).formatToParts(new Date(epoch));
  const value = (name: string) => Number(parts.find(part => part.type === name)?.value);
  return Date.UTC(value('year'), value('month') - 1, value('day'), value('hour'), value('minute'));
}
function dayAt(epoch: number, zone: string) { return Math.floor(localStamp(epoch, zone) / DAY); }
function weekday(day: number) { return ((day + 4) % 7 + 7) % 7; }

export function validateCivilSchedule(input: unknown): asserts input is CivilSchedule {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !['minuteOfDay,timeZone', 'minuteOfDay,timeZone,weekday'].includes(Object.keys(input).sort().join(','))) throw new Error('invalid_civil_schedule');
  const value = input as CivilSchedule;
  if (typeof value.timeZone !== 'string' || value.timeZone.length < 1 || value.timeZone.length > 100 || !Number.isInteger(value.minuteOfDay) || value.minuteOfDay < 0 || value.minuteOfDay > 1439 || (value.weekday !== undefined && (!Number.isInteger(value.weekday) || value.weekday < 0 || value.weekday > 6))) throw new Error('invalid_civil_schedule');
  try { formatter(value.timeZone).format(new Date(0)); } catch { throw new Error('invalid_civil_schedule'); }
}

// A fold runs once at its earlier instant. A gap shifts to the first valid
// local minute on that date; a wholly skipped date has no occurrence.
function occurrence(day: number, pattern: Pattern): number | undefined {
  const start = day * DAY + pattern.minuteOfDay * MINUTE;
  const offsets = new Set<number>();
  for (const hours of [-36, -12, 0, 12, 36]) {
    const sample = start + hours * 3_600_000;
    offsets.add(localStamp(sample, pattern.timeZone) - sample);
  }
  for (let shift = 0; shift < 1440 - pattern.minuteOfDay; shift++) {
    const local = start + shift * MINUTE;
    const candidates = [...offsets].map(offset => local - offset).filter(candidate => localStamp(candidate, pattern.timeZone) === local);
    if (candidates.length) return Math.min(...candidates);
  }
  return undefined;
}
function matching(day: number, pattern: Pattern) { return pattern.recurrence === 'daily' || weekday(day) === pattern.weekday; }
function search(start: number, direction: 1 | -1, pattern: Pattern, predicate: (value: number) => boolean) {
  // More than three weekly slots covers a skipped local date without an
  // unbounded scan after a long outage.
  for (let delta = 0; delta < 29; delta++) {
    const day = start + direction * delta;
    if (!matching(day, pattern)) continue;
    const at = occurrence(day, pattern);
    if (at !== undefined && predicate(at)) return at;
  }
  throw new Error('civil_schedule_unresolvable');
}
export function firstCivilOccurrence(at: number, recurrence: 'daily' | 'weekly', input: CivilSchedule) {
  validateCivilSchedule(input);
  if (!Number.isFinite(new Date(at).getTime()) || (recurrence === 'daily' && input.weekday !== undefined)) throw new Error('invalid_civil_schedule');
  const day = dayAt(at, input.timeZone);
  const pattern = { ...input, recurrence, weekday: input.weekday ?? weekday(day) };
  return { dueAt: search(day, 1, pattern, value => value >= at), weekday: pattern.weekday };
}
export function latestCivilOccurrence(at: number, pattern: Pattern) {
  return search(dayAt(at, pattern.timeZone), -1, pattern, value => value <= at);
}
export function nextCivilOccurrence(after: number, pattern: Pattern) {
  return search(dayAt(after, pattern.timeZone) + 1, 1, pattern, value => value > after);
}
