// FE-Q2: verification codes are valid for 10 minutes, and the resend button is
// blocked for the same period. One constant instead of a bare 600 in four pages.
export const RESEND_COUNTDOWN_SECONDS = 600;

// FE-R4: search inputs wait this long after the last keystroke before they
// trigger a request.
export const SEARCH_DEBOUNCE_MS = 300;
