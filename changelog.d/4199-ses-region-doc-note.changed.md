- **Email & SMTP docs**: `administration/email.md` now warns that a handful of
  AWS regions (Cape Town, Hyderabad, Jakarta, Milan, Zurich, Tel Aviv,
  Bahrain, UAE, Calgary, Malaysia) offer SES only over the HTTPS API, with no
  SMTP endpoint — picking the SES preset there fails silently otherwise.
