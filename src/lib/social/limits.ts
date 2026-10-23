// Limits the screens and the server must agree on, in one place so the composer never offers more than the server keeps. Pure.

/** The most hashtags one post keeps. The database check, the server's tidy-up and the composer all use this number. */
export const MAX_HASHTAGS = 30;

/** The longest caption the database holds (Facebook's own limit for a post). The form, the action and the service all refuse more, in words. */
export const MAX_CAPTION = 63_206;
