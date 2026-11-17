-- ============================================================
-- Aani Social: create public.post_reports
-- Migration: 20270214000000
-- Scope: post_reports only
-- No production execution in this task.
-- ============================================================

-- 1. Preconditions
DO $$
DECLARE
  posts_oid oid := to_regclass('public.posts');
  profiles_oid oid := to_regclass('public.profiles');
  posts_owner oid;
  profiles_owner oid;
  posts_id_att smallint;
  posts_user_att smallint;
  profiles_id_att smallint;
BEGIN
  IF posts_oid IS NULL THEN
    RAISE EXCEPTION 'Required table public.posts does not exist';
  END IF;

  IF profiles_oid IS NULL THEN
    RAISE EXCEPTION 'Required table public.profiles does not exist';
  END IF;

  IF to_regclass('public.post_reports') IS NOT NULL THEN
    RAISE EXCEPTION
      'public.post_reports already exists; stop without modifying it';
  END IF;

  SELECT relowner INTO posts_owner
  FROM pg_class WHERE oid = posts_oid;

  SELECT relowner INTO profiles_owner
  FROM pg_class WHERE oid = profiles_oid;

  SELECT attnum INTO posts_id_att
  FROM pg_attribute
  WHERE attrelid = posts_oid
    AND attname = 'id'
    AND atttypid = 'uuid'::regtype
    AND attnotnull
    AND attnum > 0
    AND NOT attisdropped;

  SELECT attnum INTO posts_user_att
  FROM pg_attribute
  WHERE attrelid = posts_oid
    AND attname = 'user_id'
    AND atttypid = 'uuid'::regtype
    AND attnotnull
    AND attnum > 0
    AND NOT attisdropped;

  SELECT attnum INTO profiles_id_att
  FROM pg_attribute
  WHERE attrelid = profiles_oid
    AND attname = 'id'
    AND atttypid = 'uuid'::regtype
    AND attnotnull
    AND attnum > 0
    AND NOT attisdropped;

  IF posts_id_att IS NULL OR posts_user_att IS NULL THEN
    RAISE EXCEPTION
      'posts.id and posts.user_id must both exist, be UUID and NOT NULL';
  END IF;

  IF profiles_id_att IS NULL THEN
    RAISE EXCEPTION
      'profiles.id must exist, be UUID and NOT NULL';
  END IF;

  -- Referenced columns must have valid single-column PK/UNIQUE constraints.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conrelid = posts_oid
      AND c.contype IN ('p', 'u')
      AND c.convalidated
      AND c.conkey = ARRAY[posts_id_att]::smallint[]
  ) THEN
    RAISE EXCEPTION
      'posts.id lacks a validated single-column primary/unique constraint';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conrelid = profiles_oid
      AND c.contype IN ('p', 'u')
      AND c.convalidated
      AND c.conkey = ARRAY[profiles_id_att]::smallint[]
  ) THEN
    RAISE EXCEPTION
      'profiles.id lacks a validated single-column primary/unique constraint';
  END IF;

  -- The migration executor must be able to create both foreign keys.
  IF NOT (
    pg_has_role(current_user, posts_owner, 'USAGE')
    OR has_table_privilege(current_user, posts_oid, 'REFERENCES')
    OR has_column_privilege(current_user, posts_oid, 'id', 'REFERENCES')
  ) THEN
    RAISE EXCEPTION
      'Migration executor lacks REFERENCES permission on public.posts';
  END IF;

  IF NOT (
    pg_has_role(current_user, profiles_owner, 'USAGE')
    OR has_table_privilege(current_user, profiles_oid, 'REFERENCES')
    OR has_column_privilege(current_user, profiles_oid, 'id', 'REFERENCES')
  ) THEN
    RAISE EXCEPTION
      'Migration executor lacks REFERENCES permission on public.profiles';
  END IF;

  -- The INSERT policy queries posts under the authenticated role.
  IF NOT has_column_privilege(
    'authenticated', posts_oid, 'id', 'SELECT'
  ) OR NOT has_column_privilege(
    'authenticated', posts_oid, 'user_id', 'SELECT'
  ) THEN
    RAISE EXCEPTION
      'authenticated requires SELECT on posts.id and posts.user_id for the INSERT policy';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     OR NOT EXISTS (
       SELECT 1 FROM pg_roles WHERE rolname = 'authenticated'
     ) THEN
    RAISE EXCEPTION 'Required Supabase roles are missing';
  END IF;

  IF to_regprocedure('gen_random_uuid()') IS NULL THEN
    RAISE EXCEPTION 'gen_random_uuid() is unavailable';
  END IF;

  IF to_regprocedure('auth.uid()') IS NULL THEN
    RAISE EXCEPTION 'auth.uid() is unavailable';
  END IF;
END
$$;

-- 2. Create the table.
CREATE TABLE public.post_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  post_id uuid NOT NULL
    REFERENCES public.posts(id)
    ON DELETE CASCADE,

  reporter_id uuid NOT NULL
    REFERENCES public.profiles(id)
    ON DELETE CASCADE,

  reason text NOT NULL
    CONSTRAINT post_reports_reason_check
    CHECK (char_length(btrim(reason)) BETWEEN 1 AND 1000),

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT post_reports_post_reporter_unique
    UNIQUE (post_id, reporter_id)
);

-- 3. Least-privilege table grants.
REVOKE ALL PRIVILEGES
ON TABLE public.post_reports
FROM PUBLIC, anon, authenticated;

GRANT INSERT, SELECT
ON TABLE public.post_reports
TO authenticated;

-- 4. Enable RLS.
ALTER TABLE public.post_reports
ENABLE ROW LEVEL SECURITY;

-- 5. A user may report a post they can read, but not their own post.
CREATE POLICY post_reports_insert_own
ON public.post_reports
FOR INSERT
TO authenticated
WITH CHECK (
  reporter_id = (SELECT auth.uid())
  AND EXISTS (
    SELECT 1
    FROM public.posts AS p
    WHERE p.id = post_reports.post_id
      AND p.user_id <> (SELECT auth.uid())
  )
);

-- 6. A reporter may read only their own reports.
CREATE POLICY post_reports_select_own
ON public.post_reports
FOR SELECT
TO authenticated
USING (
  reporter_id = (SELECT auth.uid())
);

-- 7. Reload PostgREST schema cache.
NOTIFY pgrst, 'reload schema';

-- 8. Final structural and security verification.
DO $$
DECLARE
  target oid := to_regclass('public.post_reports');
  anon_oid oid;
  auth_oid oid;
  actual_columns integer;
BEGIN
  SELECT oid INTO anon_oid
  FROM pg_roles WHERE rolname = 'anon';

  SELECT oid INTO auth_oid
  FROM pg_roles WHERE rolname = 'authenticated';

  IF target IS NULL THEN
    RAISE EXCEPTION 'post_reports was not created';
  END IF;

  -- Exactly five expected columns, with expected types and NOT NULL.
  SELECT count(*) INTO actual_columns
  FROM pg_attribute
  WHERE attrelid = target
    AND attnum > 0
    AND NOT attisdropped;

  IF actual_columns <> 5 OR (
    SELECT count(*)
    FROM pg_attribute
    WHERE attrelid = target
      AND attnum > 0
      AND NOT attisdropped
      AND (
        (attname = 'id' AND atttypid = 'uuid'::regtype AND attnotnull)
        OR (attname = 'post_id' AND atttypid = 'uuid'::regtype AND attnotnull)
        OR (attname = 'reporter_id' AND atttypid = 'uuid'::regtype AND attnotnull)
        OR (attname = 'reason' AND atttypid = 'text'::regtype AND attnotnull)
        OR (
          attname = 'created_at'
          AND atttypid = 'timestamptz'::regtype
          AND attnotnull
        )
      )
  ) <> 5 THEN
    RAISE EXCEPTION 'post_reports columns do not match the required schema';
  END IF;

  -- Verify UUID and timestamp defaults.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_attribute a
    JOIN pg_attrdef d
      ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = target
      AND a.attname = 'id'
      AND regexp_replace(
        lower(pg_get_expr(d.adbin, d.adrelid)),
        '[[:space:]()]', '', 'g'
      ) LIKE '%gen_random_uuid%'
  ) THEN
    RAISE EXCEPTION 'id UUID default is incorrect';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_attribute a
    JOIN pg_attrdef d
      ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = target
      AND a.attname = 'created_at'
      AND regexp_replace(
        lower(pg_get_expr(d.adbin, d.adrelid)),
        '[[:space:]()]', '', 'g'
      ) = 'now'
  ) THEN
    RAISE EXCEPTION 'created_at default is incorrect';
  END IF;

  -- RLS must be enabled.
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = target AND relrowsecurity
  ) THEN
    RAISE EXCEPTION 'RLS is not enabled';
  END IF;

  -- authenticated: INSERT and SELECT only.
  IF NOT has_table_privilege(auth_oid, target, 'INSERT')
     OR NOT has_table_privilege(auth_oid, target, 'SELECT')
     OR has_table_privilege(auth_oid, target, 'UPDATE')
     OR has_table_privilege(auth_oid, target, 'DELETE')
     OR has_table_privilege(auth_oid, target, 'TRUNCATE')
     OR has_table_privilege(auth_oid, target, 'REFERENCES')
     OR has_table_privilege(auth_oid, target, 'TRIGGER') THEN
    RAISE EXCEPTION 'authenticated table privileges are incorrect';
  END IF;

  -- anon must have no effective table privileges.
  IF has_table_privilege(anon_oid, target, 'SELECT')
     OR has_table_privilege(anon_oid, target, 'INSERT')
     OR has_table_privilege(anon_oid, target, 'UPDATE')
     OR has_table_privilege(anon_oid, target, 'DELETE')
     OR has_table_privilege(anon_oid, target, 'TRUNCATE')
     OR has_table_privilege(anon_oid, target, 'REFERENCES')
     OR has_table_privilege(anon_oid, target, 'TRIGGER') THEN
    RAISE EXCEPTION 'anon has unexpected table privileges';
  END IF;

  -- PUBLIC must have no direct table privileges.
  IF EXISTS (
    SELECT 1
    FROM pg_class c
    CROSS JOIN LATERAL aclexplode(
      COALESCE(c.relacl, acldefault('r', c.relowner))
    ) AS x
    WHERE c.oid = target
      AND x.grantee = 0
  ) THEN
    RAISE EXCEPTION 'PUBLIC has unexpected table privileges';
  END IF;

  -- No column-level grants to PUBLIC, anon or authenticated.
  IF EXISTS (
    SELECT 1
    FROM pg_attribute a
    CROSS JOIN LATERAL aclexplode(a.attacl) AS x
    WHERE a.attrelid = target
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND x.grantee IN (0, anon_oid, auth_oid)
  ) THEN
    RAISE EXCEPTION 'Unexpected column-level privileges exist';
  END IF;

  -- Exactly two policies, with exact roles and policy metadata.
  IF (
    SELECT count(*)
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'post_reports'
  ) <> 2 THEN
    RAISE EXCEPTION 'Unexpected number of RLS policies';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'post_reports'
      AND policyname = 'post_reports_insert_own'
      AND permissive = 'PERMISSIVE'
      AND roles = ARRAY['authenticated']::name[]
      AND cmd = 'INSERT'
      AND qual IS NULL
      AND with_check IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'INSERT policy metadata is incorrect';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'post_reports'
      AND policyname = 'post_reports_select_own'
      AND permissive = 'PERMISSIVE'
      AND roles = ARRAY['authenticated']::name[]
      AND cmd = 'SELECT'
      AND qual IS NOT NULL
      AND with_check IS NULL
  ) THEN
    RAISE EXCEPTION 'SELECT policy metadata is incorrect';
  END IF;

  -- Verify exact UNIQUE columns.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conrelid = target
      AND c.conname = 'post_reports_post_reporter_unique'
      AND c.contype = 'u'
      AND c.convalidated
      AND c.conkey = ARRAY[
        (SELECT attnum FROM pg_attribute WHERE attrelid = target AND attname = 'post_id'),
        (SELECT attnum FROM pg_attribute WHERE attrelid = target AND attname = 'reporter_id')
      ]::smallint[]
  ) THEN
    RAISE EXCEPTION 'Required UNIQUE(post_id, reporter_id) is incorrect';
  END IF;

  -- Verify both foreign keys target the correct tables and columns.
  IF (
    SELECT count(*)
    FROM pg_constraint c
    WHERE c.conrelid = target
      AND c.contype = 'f'
      AND c.convalidated
      AND c.confdeltype = 'c'
      AND (
        (
          c.confrelid = 'public.posts'::regclass
          AND c.conkey = ARRAY[
            (SELECT attnum FROM pg_attribute WHERE attrelid = target AND attname = 'post_id')
          ]::smallint[]
          AND c.confkey = ARRAY[
            (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.posts'::regclass AND attname = 'id')
          ]::smallint[]
        )
        OR
        (
          c.confrelid = 'public.profiles'::regclass
          AND c.conkey = ARRAY[
            (SELECT attnum FROM pg_attribute WHERE attrelid = target AND attname = 'reporter_id')
          ]::smallint[]
          AND c.confkey = ARRAY[
            (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.profiles'::regclass AND attname = 'id')
          ]::smallint[]
        )
      )
  ) <> 2 THEN
    RAISE EXCEPTION 'Foreign key definitions are incorrect';
  END IF;

  -- The reason CHECK must exist and be validated.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = target
      AND conname = 'post_reports_reason_check'
      AND contype = 'c'
      AND convalidated
  ) THEN
    RAISE EXCEPTION 'Reason CHECK constraint is missing or unvalidated';
  END IF;
END
$$;
