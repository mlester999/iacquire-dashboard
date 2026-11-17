// Synthetic transport tests opt in to the application send path; no-network.ts still prevents a real destination.
// The dedicated safety test removes this value to pin the server's default-off behavior.
process.env.OUTBOUND_MESSAGING_ENABLED = "true";
