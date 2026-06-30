-- Create function to check if user is super_admin
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = auth.uid()
      AND role = 'super_admin'
  )
$$;

-- Drop existing testimony policies
DROP POLICY IF EXISTS "Anyone can view testimonies" ON public.testimonies;
DROP POLICY IF EXISTS "Authenticated users can delete testimonies" ON public.testimonies;
DROP POLICY IF EXISTS "Authenticated users can insert testimonies" ON public.testimonies;
DROP POLICY IF EXISTS "Authenticated users can update testimonies" ON public.testimonies;

-- New RLS policies for testimonies

-- Super admins can view all testimonies, admins can view testimonies of published auditions
CREATE POLICY "View testimonies based on role"
ON public.testimonies
FOR SELECT
USING (
  is_super_admin() 
  OR is_admin() 
  OR EXISTS (
    SELECT 1 FROM auditions 
    WHERE auditions.id = testimonies.audition_id 
    AND auditions.status = 'published'
  )
);

-- Admins and super_admins can insert testimonies (created_by will be set)
CREATE POLICY "Admins can insert testimonies"
ON public.testimonies
FOR INSERT
WITH CHECK (
  (is_admin() OR is_super_admin()) 
  AND (created_by = auth.uid() OR created_by IS NULL)
);

-- Admins can only update their own testimonies, super_admins can update all
CREATE POLICY "Update testimonies based on ownership"
ON public.testimonies
FOR UPDATE
USING (
  is_super_admin() 
  OR (is_admin() AND created_by = auth.uid())
);

-- Admins can only delete their own testimonies, super_admins can delete all
CREATE POLICY "Delete testimonies based on ownership"
ON public.testimonies
FOR DELETE
USING (
  is_super_admin() 
  OR (is_admin() AND created_by = auth.uid())
);

-- Update user_roles policies to allow super_admin management
DROP POLICY IF EXISTS "Admins can manage roles" ON public.user_roles;
DROP POLICY IF EXISTS "Admins can view all roles" ON public.user_roles;

CREATE POLICY "Super admins can manage all roles"
ON public.user_roles
FOR ALL
USING (is_super_admin())
WITH CHECK (is_super_admin());

CREATE POLICY "Admins and super admins can view roles"
ON public.user_roles
FOR SELECT
USING (is_admin() OR is_super_admin());