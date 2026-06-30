-- First migration: Add super_admin to enum and add created_by column
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'super_admin';

ALTER TABLE public.testimonies 
ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES auth.users(id);