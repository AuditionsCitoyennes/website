/** Public testimony shape (subset of columns) joined with its audition. */
export interface PublicTestimony {
  id: string;
  person_name: string;
  person_info: string | null;
  content: string;
  topics: string[] | null;
  verification_status: string | null;
  created_at: string | null;
  audition: {
    id: string;
    title: string;
    location: string;
    date: string;
  } | null;
}
