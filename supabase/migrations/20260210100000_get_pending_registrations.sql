CREATE OR REPLACE FUNCTION public.get_pending_registrations()
RETURNS TABLE(
  user_id uuid,
  email text,
  username text,
  bio text,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF NOT public.is_super_admin() THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    u.id as user_id,
    u.email::text,
    (u.raw_user_meta_data->>'username')::text as username,
    (u.raw_user_meta_data->>'bio')::text as bio,
    u.created_at
  FROM auth.users u
  WHERE u.email_confirmed_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.user_roles ur WHERE ur.user_id = u.id
    )
  ORDER BY u.created_at DESC;
END;
$$;
