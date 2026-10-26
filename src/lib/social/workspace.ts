// Where social media lives. The accounts belong to the CLIENT and an agency never approves what a client publishes, so the feature exists inside each client's
// workspace and nowhere else: an agency workspace has no social media of its own. Pure, so the interface and the server say the same words.

export const SOCIAL_CLIENT_ONLY_MESSAGE = "Social media is managed inside each client's workspace. Open the client's workspace to work with its accounts and posts.";

/** Whether a workspace of this kind has social media. */
export const socialAvailableIn = (kind: "agency" | "client"): boolean => kind === "client";
