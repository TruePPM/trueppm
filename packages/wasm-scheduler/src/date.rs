//! In-crate civil-date type that replaces the `chrono` crate.
//!
//! `chrono` is unmaintained (RUSTSEC-2026-0543, all versions affected, no safe
//! upgrade), and the engine only ever used a small slice of it: a calendar date
//! with day arithmetic, the weekday, the day count since the Common Era, and a
//! `"YYYY-MM-DD"` serde form. This module is that slice and nothing more, with the
//! same method names so call sites changed only their `use` line.
//!
//! A [`NaiveDate`] is a proleptic-Gregorian date stored as a day count where
//! 0001-01-01 is day 1 (chrono's `num_days_from_ce`). Conversion to and from
//! year/month/day uses Howard Hinnant's `days_from_civil` / `civil_from_days`
//! algorithms (<https://howardhinnant.github.io/date_algorithms.html>), which work
//! on 400-year eras so the century rule (1900 is not a leap year, 2000 is) needs no
//! special case.
//!
//! Range matches chrono's so the existing overflow and validation-cap behavior is
//! unchanged: [`NaiveDate::MIN`] is -262143-01-01 and [`NaiveDate::MAX`] is
//! +262142-12-31. Arithmetic past either end **panics** like chrono's `+`/`-`
//! (the `checked_*` variants return `None`), and never wraps.

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;
use std::ops::{Add, AddAssign, Sub, SubAssign};

/// Day count of 1970-01-01 in the days-from-CE numbering (0001-01-01 is day 1).
const UNIX_EPOCH_CE: i64 = 719_163;

/// Year range of [`NaiveDate::MIN`]..=[`NaiveDate::MAX`].
const MIN_YEAR: i32 = -262_143;
const MAX_YEAR: i32 = 262_142;

/// A signed whole number of days; the only duration the engine needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Duration(i64);

impl Duration {
    /// A duration of `n` days.
    pub const fn days(n: i64) -> Self {
        Duration(n)
    }

    /// The number of whole days.
    pub const fn num_days(&self) -> i64 {
        self.0
    }
}

/// Day of the week; only the Monday-based index is used by the calendar.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Weekday(u32);

impl Weekday {
    /// Monday = 0 .. Sunday = 6.
    pub const fn num_days_from_monday(&self) -> u32 {
        self.0
    }
}

/// Why a date string was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParseError {
    /// Not exactly `YYYY-MM-DD` with ASCII digits.
    Invalid,
    /// Well shaped but not a real calendar date (month 13, 30 February, ...).
    OutOfRange,
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            ParseError::Invalid => "input contains invalid characters",
            ParseError::OutOfRange => "input is out of range",
        })
    }
}

impl std::error::Error for ParseError {}

/// A proleptic-Gregorian calendar date with no time zone.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct NaiveDate {
    /// Days since the Common Era: 0001-01-01 is 1.
    ce: i32,
}

/// Days from 1970-01-01 for a civil date (Hinnant `days_from_civil`).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12; // March = 0
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Civil date for a day count from 1970-01-01 (Hinnant `civil_from_days`).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn is_leap(y: i32) -> bool {
    y % 4 == 0 && (y % 100 != 0 || y % 400 == 0)
}

fn days_in_month(y: i32, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if is_leap(y) => 29,
        _ => 28,
    }
}

impl NaiveDate {
    /// The earliest representable date, -262143-01-01 (chrono's `MIN`).
    pub const MIN: NaiveDate = NaiveDate { ce: -95_746_129 };
    /// The latest representable date, +262142-12-31 (chrono's `MAX`).
    pub const MAX: NaiveDate = NaiveDate { ce: 95_745_399 };

    /// The date for a year, month (1-12) and day, or `None` if it does not exist
    /// or is outside `MIN..=MAX`.
    pub fn from_ymd_opt(year: i32, month: u32, day: u32) -> Option<NaiveDate> {
        if !(MIN_YEAR..=MAX_YEAR).contains(&year)
            || !(1..=12).contains(&month)
            || day < 1
            || day > days_in_month(year, month)
        {
            return None;
        }
        let unix = days_from_civil(i64::from(year), i64::from(month), i64::from(day));
        Some(NaiveDate {
            ce: (unix + UNIX_EPOCH_CE) as i32,
        })
    }

    /// The date `days` after the Common Era origin (0001-01-01 is 1), or `None`
    /// outside `MIN..=MAX`.
    pub fn from_num_days_from_ce_opt(days: i32) -> Option<NaiveDate> {
        (Self::MIN.ce..=Self::MAX.ce)
            .contains(&days)
            .then_some(NaiveDate { ce: days })
    }

    /// Days since the Common Era origin: 0001-01-01 is 1.
    pub const fn num_days_from_ce(&self) -> i32 {
        self.ce
    }

    fn ymd(&self) -> (i32, u32, u32) {
        let (y, m, d) = civil_from_days(i64::from(self.ce) - UNIX_EPOCH_CE);
        (y as i32, m, d)
    }

    /// The (proleptic Gregorian) year; year 0 is 1 BCE.
    pub fn year(&self) -> i32 {
        self.ymd().0
    }

    /// The month, 1-12.
    pub fn month(&self) -> u32 {
        self.ymd().1
    }

    /// The day of the month, 1-31.
    pub fn day(&self) -> u32 {
        self.ymd().2
    }

    /// The day of the week. 0001-01-01 (day 1) is a Monday.
    pub fn weekday(&self) -> Weekday {
        Weekday((i64::from(self.ce) - 1).rem_euclid(7) as u32)
    }

    /// `self + rhs`, or `None` if the result is outside `MIN..=MAX`.
    pub fn checked_add_signed(self, rhs: Duration) -> Option<NaiveDate> {
        let ce = i64::from(self.ce).checked_add(rhs.0)?;
        i32::try_from(ce)
            .ok()
            .and_then(Self::from_num_days_from_ce_opt)
    }

    /// `self - rhs`, or `None` if the result is outside `MIN..=MAX`.
    pub fn checked_sub_signed(self, rhs: Duration) -> Option<NaiveDate> {
        let ce = i64::from(self.ce).checked_sub(rhs.0)?;
        i32::try_from(ce)
            .ok()
            .and_then(Self::from_num_days_from_ce_opt)
    }

    /// Parse the canonical `YYYY-MM-DD` form: exactly ten ASCII characters, four
    /// digits, a dash, two digits, a dash, two digits, naming a real date.
    ///
    /// Deliberately stricter than chrono's `%Y-%m-%d`, which also took `2026-1-5`,
    /// a leading `+`/`-` or space and negative years. The engine never used that
    /// leniency: every date field was pre-checked to this exact shape (#4707).
    pub fn parse_iso(s: &str) -> Result<NaiveDate, ParseError> {
        let b = s.as_bytes();
        let shaped = b.len() == 10
            && b.iter().enumerate().all(|(i, c)| match i {
                4 | 7 => *c == b'-',
                _ => c.is_ascii_digit(),
            });
        if !shaped {
            return Err(ParseError::Invalid);
        }
        let num = |r: std::ops::Range<usize>| s[r].parse::<u32>().map_err(|_| ParseError::Invalid);
        let (y, m, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
        NaiveDate::from_ymd_opt(y as i32, m, d).ok_or(ParseError::OutOfRange)
    }
}

impl fmt::Display for NaiveDate {
    /// `YYYY-MM-DD`; a year outside 0000..=9999 carries a sign and at least four
    /// digits (`+12345-01-01`, `-0001-01-01`), as chrono printed it.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let (y, m, d) = self.ymd();
        if (0..=9999).contains(&y) {
            write!(f, "{y:04}-{m:02}-{d:02}")
        } else {
            write!(f, "{y:+05}-{m:02}-{d:02}")
        }
    }
}

impl Add<Duration> for NaiveDate {
    type Output = NaiveDate;
    /// Panics if the result is outside `MIN..=MAX`, like chrono.
    fn add(self, rhs: Duration) -> NaiveDate {
        self.checked_add_signed(rhs)
            .expect("`NaiveDate + Duration` overflowed")
    }
}

impl Sub<Duration> for NaiveDate {
    type Output = NaiveDate;
    /// Panics if the result is outside `MIN..=MAX`, like chrono.
    fn sub(self, rhs: Duration) -> NaiveDate {
        self.checked_sub_signed(rhs)
            .expect("`NaiveDate - Duration` overflowed")
    }
}

impl Sub<NaiveDate> for NaiveDate {
    type Output = Duration;
    fn sub(self, rhs: NaiveDate) -> Duration {
        Duration(i64::from(self.ce) - i64::from(rhs.ce))
    }
}

impl AddAssign<Duration> for NaiveDate {
    fn add_assign(&mut self, rhs: Duration) {
        *self = *self + rhs;
    }
}

impl SubAssign<Duration> for NaiveDate {
    fn sub_assign(&mut self, rhs: Duration) {
        *self = *self - rhs;
    }
}

impl Serialize for NaiveDate {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for NaiveDate {
    /// Canonical `YYYY-MM-DD` only; see [`NaiveDate::parse_iso`].
    fn deserialize<D: Deserializer<'de>>(de: D) -> Result<NaiveDate, D::Error> {
        let s = String::deserialize(de)?;
        NaiveDate::parse_iso(&s).map_err(D::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(y: i32, m: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, day).unwrap()
    }

    #[test]
    fn known_ce_ordinals() {
        assert_eq!(d(1, 1, 1).num_days_from_ce(), 1);
        assert_eq!(d(1970, 1, 1).num_days_from_ce(), 719_163);
        assert_eq!(d(2000, 1, 1).num_days_from_ce(), 730_120);
        assert_eq!(d(2026, 1, 5).num_days_from_ce(), 739_621);
    }

    #[test]
    fn ymd_roundtrip_across_leap_and_century_rules() {
        for y in [
            1, 4, 100, 400, 1600, 1899, 1900, 1904, 2000, 2024, 2026, 2100, 2400, 9999, 12_345,
        ] {
            for m in 1..=12 {
                for day in 1..=days_in_month(y, m) {
                    let date = d(y, m, day);
                    assert_eq!((date.year(), date.month(), date.day()), (y, m, day));
                    assert_eq!(
                        NaiveDate::from_num_days_from_ce_opt(date.num_days_from_ce()),
                        Some(date)
                    );
                }
            }
        }
    }

    #[test]
    fn consecutive_days_are_consecutive_ordinals_across_the_leap_rules() {
        let mut prev = d(1899, 12, 31);
        for _ in 0..(366 * 600) {
            let next = prev + Duration::days(1);
            assert_eq!(next.num_days_from_ce(), prev.num_days_from_ce() + 1);
            assert!(next > prev);
            prev = next;
        }
        // 1900 and 2100 are not leap years, 2000 is.
        assert!(NaiveDate::from_ymd_opt(1900, 2, 29).is_none());
        assert!(NaiveDate::from_ymd_opt(2100, 2, 29).is_none());
        assert!(NaiveDate::from_ymd_opt(2000, 2, 29).is_some());
        assert_eq!(d(1900, 3, 1) - d(1900, 2, 28), Duration::days(1));
        assert_eq!(d(2000, 3, 1) - d(2000, 2, 28), Duration::days(2));
        assert_eq!(d(2100, 3, 1) - d(2100, 2, 28), Duration::days(1));
    }

    #[test]
    fn weekday_matches_known_dates() {
        assert_eq!(d(1, 1, 1).weekday().num_days_from_monday(), 0); // Monday
        assert_eq!(d(1970, 1, 1).weekday().num_days_from_monday(), 3); // Thursday
        assert_eq!(d(2000, 1, 1).weekday().num_days_from_monday(), 5); // Saturday
        assert_eq!(d(2026, 1, 5).weekday().num_days_from_monday(), 0); // Monday
        assert_eq!(d(2024, 2, 29).weekday().num_days_from_monday(), 3); // Thursday
        assert_eq!(d(2026, 11, 22).weekday().num_days_from_monday(), 6); // Sunday
        assert_eq!(d(-1, 1, 1).weekday().num_days_from_monday(), 4);
    }

    #[test]
    fn bounds_match_chrono_and_overflow_is_checked() {
        assert_eq!(NaiveDate::MAX, d(262_142, 12, 31));
        assert_eq!(NaiveDate::MIN, d(-262_143, 1, 1));
        assert!(NaiveDate::from_ymd_opt(262_143, 1, 1).is_none());
        assert!(NaiveDate::from_ymd_opt(-262_144, 12, 31).is_none());
        assert!(
            NaiveDate::from_num_days_from_ce_opt(NaiveDate::MAX.num_days_from_ce() + 1).is_none()
        );
        assert!(
            NaiveDate::from_num_days_from_ce_opt(NaiveDate::MIN.num_days_from_ce() - 1).is_none()
        );
        assert_eq!(NaiveDate::MAX.checked_add_signed(Duration::days(1)), None);
        assert_eq!(NaiveDate::MIN.checked_sub_signed(Duration::days(1)), None);
        assert_eq!(
            NaiveDate::MAX.checked_add_signed(Duration::days(i64::MAX)),
            None
        );
        assert_eq!(
            NaiveDate::MAX.checked_sub_signed(Duration::days(1)),
            Some(d(262_142, 12, 30))
        );
    }

    #[test]
    #[should_panic(expected = "overflowed")]
    fn add_past_max_panics() {
        let _ = NaiveDate::MAX + Duration::days(1);
    }

    #[test]
    #[should_panic(expected = "overflowed")]
    fn sub_past_min_panics() {
        let _ = NaiveDate::MIN - Duration::days(1);
    }

    #[test]
    fn display_and_serde_use_the_canonical_form() {
        assert_eq!(d(2026, 1, 5).to_string(), "2026-01-05");
        assert_eq!(d(1, 1, 1).to_string(), "0001-01-01");
        assert_eq!(d(12_345, 1, 1).to_string(), "+12345-01-01");
        assert_eq!(d(-1, 1, 1).to_string(), "-0001-01-01");
        assert_eq!(NaiveDate::MAX.to_string(), "+262142-12-31");
        assert_eq!(
            serde_json::to_string(&d(2026, 1, 5)).unwrap(),
            "\"2026-01-05\""
        );
        assert_eq!(
            serde_json::from_str::<NaiveDate>("\"2026-01-05\"").unwrap(),
            d(2026, 1, 5)
        );
        assert!(serde_json::from_str::<NaiveDate>("\"2026-1-5\"").is_err());
    }

    #[test]
    fn parse_accepts_canonical_and_rejects_everything_else() {
        assert_eq!(NaiveDate::parse_iso("2024-02-29"), Ok(d(2024, 2, 29)));
        assert_eq!(NaiveDate::parse_iso("0001-01-01"), Ok(d(1, 1, 1)));
        assert_eq!(NaiveDate::parse_iso("9999-12-31"), Ok(d(9999, 12, 31)));
        assert_eq!(NaiveDate::parse_iso("0000-01-01"), Ok(d(0, 1, 1)));
        for bad in [
            "2026-1-5",
            "+2026-01-05",
            "02026-01-05",
            "2026-01-05 ",
            " 2026-01-05",
            "-0001-01-01",
            "10000-01-01",
            "2026-01-05T",
            "2026-01-05\n",
            "2026- 1-05",
            "2026-001-05",
            "",
            "2026/01/05",
            "２０２６-01-05",
        ] {
            assert_eq!(
                NaiveDate::parse_iso(bad),
                Err(ParseError::Invalid),
                "{bad:?}"
            );
        }
        for bad in [
            "2026-02-30",
            "2026-13-01",
            "2026-01-32",
            "2026-02-29",
            "1900-02-29",
            "2026-00-10",
            "2026-01-00",
        ] {
            assert_eq!(
                NaiveDate::parse_iso(bad),
                Err(ParseError::OutOfRange),
                "{bad:?}"
            );
        }
        assert_eq!(ParseError::OutOfRange.to_string(), "input is out of range");
    }
}
