-- Add email and verification fields to testimonies table
ALTER TABLE public.testimonies
ADD COLUMN email text,
ADD COLUMN verification_token uuid DEFAULT gen_random_uuid(),
ADD COLUMN verification_status text DEFAULT 'pending' CHECK (verification_status IN ('pending', 'verified', 'rejected'));

-- Create index for verification token lookups
CREATE INDEX idx_testimonies_verification_token ON public.testimonies(verification_token);

-- Update RLS policy to allow public access for verification page
CREATE POLICY "Anyone can view testimony for verification"
ON public.testimonies
FOR SELECT
USING (verification_token IS NOT NULL);

-- Allow public update for verification (approve/reject)
CREATE POLICY "Public can verify their own testimony"
ON public.testimonies
FOR UPDATE
USING (verification_token IS NOT NULL)
WITH CHECK (verification_token IS NOT NULL);