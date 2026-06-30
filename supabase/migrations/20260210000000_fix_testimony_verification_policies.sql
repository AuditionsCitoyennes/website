-- Allow anonymous users to update their own testimony via verification token
-- (for verify, reject, and edit actions from the email link)
CREATE POLICY "Anon can update testimony by token"
ON public.testimonies
FOR UPDATE
USING (verification_token IS NOT NULL)
WITH CHECK (verification_token IS NOT NULL);

-- Allow anonymous users to delete their testimony via verification token (reject)
CREATE POLICY "Anon can delete testimony by token"
ON public.testimonies
FOR DELETE
USING (verification_token IS NOT NULL AND verification_status = 'pending');
