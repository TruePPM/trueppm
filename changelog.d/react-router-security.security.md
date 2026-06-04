- **react-router upgraded to 7.16.0**: patches a high-severity advisory chain in
  react-router 7.0.0–7.14.2 (vendored turbo-stream RCE via TYPE_ERROR
  deserialization, open redirect via protocol-relative URLs, XSS in RSC redirect
  handling, stored XSS via unescaped `Location` header, and a `__manifest` DoS).
