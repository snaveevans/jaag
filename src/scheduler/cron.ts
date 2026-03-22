import type { ScheduleTriggerType } from "./types.ts";

const CRON_FIELD_COUNT = 5;
const MAX_SEARCH_YEAR_SPAN = 8;

interface LocalDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

interface ParsedCronField {
  values: number[];
  valueSet: Set<number>;
  wildcard: boolean;
}

export interface ParsedCronExpression {
  raw: string;
  minute: ParsedCronField;
  hour: ParsedCronField;
  dayOfMonth: ParsedCronField;
  month: ParsedCronField;
  dayOfWeek: ParsedCronField;
}

export function assertSupportedScheduleTriggerType(triggerType: ScheduleTriggerType): void {
  if (triggerType === "event") {
    throw new Error("Event schedules are not supported yet.");
  }
}

export function assertValidTimeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
  } catch {
    throw new Error(`Invalid runtime timezone: ${timeZone}`);
  }

  return timeZone;
}

export function parseCronExpression(expression: string): ParsedCronExpression {
  const renderedExpression = expression.trim();
  if (renderedExpression === "") {
    throw new Error("Invalid cron expression: expected a non-empty string.");
  }

  const fields = renderedExpression.split(/\s+/);
  if (fields.length !== CRON_FIELD_COUNT) {
    throw new Error("Invalid cron expression: expected 5 fields (minute hour day-of-month month day-of-week).");
  }

  return {
    raw: renderedExpression,
    minute: parseField(fields[0] ?? "", 0, 59, "minute"),
    hour: parseField(fields[1] ?? "", 0, 23, "hour"),
    dayOfMonth: parseField(fields[2] ?? "", 1, 31, "day-of-month"),
    month: parseField(fields[3] ?? "", 1, 12, "month"),
    dayOfWeek: parseField(fields[4] ?? "", 0, 7, "day-of-week", { normalizeDayOfWeek: true }),
  };
}

export function computeNextCronOccurrence(
  expression: string | ParsedCronExpression,
  after: Date,
  timeZone: string,
): Date {
  const parsed = typeof expression === "string" ? parseCronExpression(expression) : expression;
  assertValidTimeZone(timeZone);

  const candidate = getZonedDateTime(after, timeZone);
  candidate.second = 0;
  incrementMinute(candidate);

  const maxYear = candidate.year + MAX_SEARCH_YEAR_SPAN;
  while (candidate.year <= maxYear) {
    const nextMonth = nextOrSame(parsed.month.values, candidate.month);
    if (nextMonth === null) {
      candidate.year += 1;
      candidate.month = parsed.month.values[0] ?? 1;
      candidate.day = 1;
      candidate.hour = 0;
      candidate.minute = 0;
      continue;
    }

    if (nextMonth !== candidate.month) {
      candidate.month = nextMonth;
      candidate.day = 1;
      candidate.hour = 0;
      candidate.minute = 0;
    }

    const daysInCurrentMonth = getDaysInMonth(candidate.year, candidate.month);
    if (candidate.day > daysInCurrentMonth) {
      candidate.day = 1;
      candidate.hour = 0;
      candidate.minute = 0;
      incrementMonth(candidate);
      continue;
    }

    if (!matchesDay(parsed, candidate)) {
      candidate.day += 1;
      candidate.hour = 0;
      candidate.minute = 0;
      normalizeDate(candidate);
      continue;
    }

    const nextHour = nextOrSame(parsed.hour.values, candidate.hour);
    if (nextHour === null) {
      candidate.day += 1;
      candidate.hour = 0;
      candidate.minute = 0;
      normalizeDate(candidate);
      continue;
    }

    if (nextHour !== candidate.hour) {
      candidate.hour = nextHour;
      candidate.minute = 0;
    }

    const nextMinute = nextOrSame(parsed.minute.values, candidate.minute);
    if (nextMinute === null) {
      candidate.hour += 1;
      candidate.minute = 0;
      normalizeDate(candidate);
      continue;
    }

    candidate.minute = nextMinute;

    if (!matchesDay(parsed, candidate)) {
      candidate.day += 1;
      candidate.hour = 0;
      candidate.minute = 0;
      normalizeDate(candidate);
      continue;
    }

    const occurrence = localDateTimeToUtc(candidate, timeZone);
    if (!occurrence || occurrence.getTime() <= after.getTime()) {
      incrementMinute(candidate);
      continue;
    }

    return occurrence;
  }

  throw new Error(`Unable to compute the next cron occurrence for ${parsed.raw}.`);
}

function parseField(
  field: string,
  min: number,
  max: number,
  label: string,
  options: { normalizeDayOfWeek?: boolean } = {},
): ParsedCronField {
  const renderedField = field.trim();
  if (renderedField === "") {
    throw new Error(`Invalid cron ${label}: field must not be empty.`);
  }

  const values = new Set<number>();
  const segments = renderedField.split(",");
  for (const rawSegment of segments) {
    const segment = rawSegment.trim();
    if (segment === "") {
      throw new Error(`Invalid cron ${label}: empty list segment.`);
    }

    parseSegment(segment, min, max, label, values, options);
  }

  if (values.size === 0) {
    throw new Error(`Invalid cron ${label}: no values matched.`);
  }

  const sortedValues = [...values].sort((left, right) => left - right);
  return {
    values: sortedValues,
    valueSet: new Set(sortedValues),
    wildcard: renderedField === "*",
  };
}

function parseSegment(
  segment: string,
  min: number,
  max: number,
  label: string,
  target: Set<number>,
  options: { normalizeDayOfWeek?: boolean },
): void {
  const [rangePart, stepPart] = segment.split("/");
  const step = stepPart === undefined ? 1 : parseStep(stepPart, label);

  if (rangePart === "*") {
    addRange(target, min, max, step, options);
    return;
  }

  const rangeMatch = /^(\d+)-(\d+)$/.exec(rangePart ?? "");
  if (rangeMatch) {
    const start = parseBoundedNumber(rangeMatch[1] ?? "", min, max, label, options);
    const end = parseBoundedNumber(rangeMatch[2] ?? "", min, max, label, options);
    if (start > end) {
      throw new Error(`Invalid cron ${label}: range start must be <= range end.`);
    }

    addRange(target, start, end, step, options);
    return;
  }

  const value = parseBoundedNumber(rangePart ?? "", min, max, label, options);
  if (step !== 1) {
    addRange(target, value, max, step, options);
    return;
  }

  target.add(value);
}

function parseStep(stepPart: string, label: string): number {
  const step = Number(stepPart);
  if (!Number.isInteger(step) || step < 1) {
    throw new Error(`Invalid cron ${label}: step must be an integer >= 1.`);
  }

  return step;
}

function parseBoundedNumber(
  value: string,
  min: number,
  max: number,
  label: string,
  options: { normalizeDayOfWeek?: boolean },
): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid cron ${label}: expected an integer between ${min} and ${max}.`);
  }

  if (options.normalizeDayOfWeek && parsed === 7) {
    return 0;
  }

  return parsed;
}

function addRange(
  target: Set<number>,
  start: number,
  end: number,
  step: number,
  options: { normalizeDayOfWeek?: boolean },
): void {
  for (let current = start; current <= end; current += step) {
    if (options.normalizeDayOfWeek && current === 7) {
      target.add(0);
      continue;
    }

    target.add(current);
  }
}

function matchesDay(parsed: ParsedCronExpression, candidate: LocalDateTime): boolean {
  const dayOfMonthMatch = parsed.dayOfMonth.valueSet.has(candidate.day);
  const dayOfWeekMatch = parsed.dayOfWeek.valueSet.has(getDayOfWeek(candidate.year, candidate.month, candidate.day));

  if (parsed.dayOfMonth.wildcard && parsed.dayOfWeek.wildcard) {
    return true;
  }

  if (parsed.dayOfMonth.wildcard) {
    return dayOfWeekMatch;
  }

  if (parsed.dayOfWeek.wildcard) {
    return dayOfMonthMatch;
  }

  return dayOfMonthMatch || dayOfWeekMatch;
}

function nextOrSame(values: number[], candidate: number): number | null {
  for (const value of values) {
    if (value >= candidate) {
      return value;
    }
  }

  return null;
}

function incrementMinute(candidate: LocalDateTime): void {
  candidate.minute += 1;
  normalizeDate(candidate);
}

function incrementMonth(candidate: LocalDateTime): void {
  candidate.month += 1;
  candidate.day = 1;
  normalizeDate(candidate);
}

function normalizeDate(candidate: LocalDateTime): void {
  if (candidate.minute >= 60) {
    candidate.hour += Math.floor(candidate.minute / 60);
    candidate.minute %= 60;
  }

  if (candidate.hour >= 24) {
    candidate.day += Math.floor(candidate.hour / 24);
    candidate.hour %= 24;
  }

  while (candidate.month > 12) {
    candidate.year += 1;
    candidate.month -= 12;
  }

  while (candidate.day > getDaysInMonth(candidate.year, candidate.month)) {
    candidate.day -= getDaysInMonth(candidate.year, candidate.month);
    candidate.month += 1;
    if (candidate.month > 12) {
      candidate.year += 1;
      candidate.month = 1;
    }
  }
}

function getDaysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function getDayOfWeek(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function getZonedDateTime(date: Date, timeZone: string): LocalDateTime {
  const formatter = getDateTimeFormatter(timeZone);
  const parts = formatter.formatToParts(date);
  const lookup = new Map(parts.map((part) => [part.type, part.value]));

  return {
    year: Number(lookup.get("year")),
    month: Number(lookup.get("month")),
    day: Number(lookup.get("day")),
    hour: Number(lookup.get("hour")),
    minute: Number(lookup.get("minute")),
    second: Number(lookup.get("second")),
  };
}

function localDateTimeToUtc(localDateTime: LocalDateTime, timeZone: string): Date | null {
  const naiveUtcMs = Date.UTC(
    localDateTime.year,
    localDateTime.month - 1,
    localDateTime.day,
    localDateTime.hour,
    localDateTime.minute,
    localDateTime.second,
    0,
  );

  let candidateMs = naiveUtcMs - getTimeZoneOffsetMs(new Date(naiveUtcMs), timeZone);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const offsetMs = getTimeZoneOffsetMs(new Date(candidateMs), timeZone);
    const adjustedMs = naiveUtcMs - offsetMs;
    if (adjustedMs === candidateMs) {
      break;
    }

    candidateMs = adjustedMs;
  }

  const directCandidate = new Date(candidateMs);
  if (sameLocalMinute(getZonedDateTime(directCandidate, timeZone), localDateTime)) {
    return directCandidate;
  }

  const searchStartMs = candidateMs - (3 * 60 * 60 * 1000);
  const searchEndMs = candidateMs + (3 * 60 * 60 * 1000);
  for (let probeMs = searchStartMs; probeMs <= searchEndMs; probeMs += 60_000) {
    const probe = new Date(probeMs);
    if (sameLocalMinute(getZonedDateTime(probe, timeZone), localDateTime)) {
      return probe;
    }
  }

  return null;
}

function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const zoned = getZonedDateTime(date, timeZone);
  const asUtcMs = Date.UTC(zoned.year, zoned.month - 1, zoned.day, zoned.hour, zoned.minute, zoned.second, 0);
  return asUtcMs - date.getTime();
}

function sameLocalMinute(left: LocalDateTime, right: LocalDateTime): boolean {
  return left.year === right.year
    && left.month === right.month
    && left.day === right.day
    && left.hour === right.hour
    && left.minute === right.minute;
}

const DATE_TIME_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function getDateTimeFormatter(timeZone: string): Intl.DateTimeFormat {
  const existing = DATE_TIME_FORMATTERS.get(timeZone);
  if (existing) {
    return existing;
  }

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  DATE_TIME_FORMATTERS.set(timeZone, formatter);
  return formatter;
}
