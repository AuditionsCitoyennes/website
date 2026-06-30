-- Create audit_log table
CREATE TABLE IF NOT EXISTS public.audit_log (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  action text NOT NULL,
  target_type text,
  target_id text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

-- Only super_admin can read audit logs
CREATE POLICY "super_admin_read_audit_log"
  ON public.audit_log
  FOR SELECT
  USING (public.is_super_admin());

-- No direct INSERT allowed (use the function instead)
-- No UPDATE or DELETE policies

-- SECURITY DEFINER function to insert audit log entries
CREATE OR REPLACE FUNCTION public.insert_audit_log(
  p_user_id uuid,
  p_action text,
  p_target_type text DEFAULT NULL,
  p_target_id text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO public.audit_log (user_id, action, target_type, target_id, metadata)
  VALUES (p_user_id, p_action, p_target_type, p_target_id, p_metadata);
END;
$$;

-- SECURITY DEFINER RPC to fetch audit log with user email
CREATE OR REPLACE FUNCTION public.get_audit_log(
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  action text,
  target_type text,
  target_id text,
  metadata jsonb,
  created_at timestamptz,
  user_email text
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Only super_admin can call this
  IF NOT public.is_super_admin() THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    al.id,
    al.action,
    al.target_type,
    al.target_id,
    al.metadata,
    al.created_at,
    u.email::text AS user_email
  FROM public.audit_log al
  LEFT JOIN auth.users u ON u.id = al.user_id
  ORDER BY al.created_at DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$$;
