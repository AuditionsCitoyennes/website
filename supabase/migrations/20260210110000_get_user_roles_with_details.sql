CREATE OR REPLACE FUNCTION public.get_user_roles_with_details()
RETURNS TABLE(
  id uuid,
  user_id uuid,
  role text,
  created_at timestamptz,
  email text,
  username text
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
    ur.id,
    ur.user_id,
    ur.role::text,
    ur.created_at,
    u.email::text,
    (u.raw_user_meta_data->>'username')::text as username
  FROM public.user_roles ur
  LEFT JOIN auth.users u ON u.id = ur.user_id
  ORDER BY ur.created_at DESC;
END;
$$;
