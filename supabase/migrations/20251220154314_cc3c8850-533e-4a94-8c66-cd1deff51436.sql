-- Allow first admin setup: if no admins exist, any authenticated user can become admin
CREATE POLICY "Allow first admin setup"
ON public.user_roles
FOR INSERT
TO authenticated
WITH CHECK (
  role = 'admin' AND
  NOT EXISTS (SELECT 1 FROM public.user_roles WHERE role = 'admin')
);