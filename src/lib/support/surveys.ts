/** What the client is shown about a satisfaction survey, and nothing about anyone else. */
export interface SurveyView {
  id: string;
  rating: number | null;
  helpful: boolean | null;
  comment: string | null;
  requestedAt: string;
  expiresAt: string | null;
}
