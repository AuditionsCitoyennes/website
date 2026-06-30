-- Create enum for audition status
CREATE TYPE public.audition_status AS ENUM ('published', 'draft');

-- Create auditions table
CREATE TABLE public.auditions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  date DATE NOT NULL,
  location TEXT NOT NULL,
  content TEXT NOT NULL,
  status audition_status DEFAULT 'published',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.auditions ENABLE ROW LEVEL SECURITY;

-- Public can read published auditions
CREATE POLICY "Anyone can view published auditions"
  ON public.auditions
  FOR SELECT
  USING (status = 'published');

-- Authenticated users can create/update/delete auditions (for admin)
CREATE POLICY "Authenticated users can insert auditions"
  ON public.auditions
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update auditions"
  ON public.auditions
  FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated users can delete auditions"
  ON public.auditions
  FOR DELETE
  TO authenticated
  USING (true);

-- Create testimonies table for individual testimonies within auditions
CREATE TABLE public.testimonies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audition_id UUID REFERENCES public.auditions(id) ON DELETE CASCADE,
  person_name TEXT NOT NULL,
  person_info TEXT,
  content TEXT NOT NULL,
  topics TEXT[], -- Array of topics mentioned
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.testimonies ENABLE ROW LEVEL SECURITY;

-- Public can read testimonies of published auditions
CREATE POLICY "Anyone can view testimonies"
  ON public.testimonies
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.auditions 
      WHERE auditions.id = testimonies.audition_id 
      AND auditions.status = 'published'
    )
  );

-- Authenticated users can manage testimonies
CREATE POLICY "Authenticated users can insert testimonies"
  ON public.testimonies
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update testimonies"
  ON public.testimonies
  FOR UPDATE
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can delete testimonies"
  ON public.testimonies
  FOR DELETE
  TO authenticated
  USING (true);

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Add trigger to auditions table
CREATE TRIGGER set_auditions_updated_at
  BEFORE UPDATE ON public.auditions
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_updated_at();