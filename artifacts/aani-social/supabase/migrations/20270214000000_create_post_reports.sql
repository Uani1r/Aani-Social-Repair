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


-- 9. Semantic verification of the reason CHECK and both policy predicates.
--    The checks evaluate the expressions PostgreSQL stored (pg_get_expr) instead
--    of comparing constraint or policy text, and are skipped with a NOTICE when
--    the environment cannot simulate auth.uid() (auth.uid() not driven by
--    request.jwt.claims) or when public.posts holds no post owned by a user
--    other than the simulated reporter.
DO $$
DECLARE
  reason_expr text;
  select_expr text;
  insert_expr text;
  results boolean[];
  verdict boolean;
  v_post uuid;
  v_author uuid;
  v_other uuid := '00000000-0000-0000-0000-000000000001'::uuid;
  v_third uuid := '00000000-0000-0000-0000-000000000002'::uuid;
  v_missing uuid;
  v_claims text := current_setting('request.jwt.claims', true);
  v_sub text := current_setting('request.jwt.claim.sub', true);
BEGIN
  -- A post id that is guaranteed absent from public.posts, generated at run
  -- time instead of hardcoded, so the "non-existent post" test can never
  -- coincide with a real row. The bounded loop ends as soon as an absent id is
  -- found; the following block fails loudly if none was found within the bound.
  v_missing := gen_random_uuid();

  FOR i IN 1..10 LOOP
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.posts AS post WHERE post.id = v_missing);
    v_missing := gen_random_uuid();
  END LOOP;

  IF EXISTS (SELECT 1 FROM public.posts AS post WHERE post.id = v_missing) THEN
    RAISE EXCEPTION
      'Could not generate a post id absent from public.posts after 10 attempts';
  END IF;

  -- (a) The reason CHECK must accept 1..1000 characters after btrim and reject
  --     everything else, evaluated on literal values.
  SELECT pg_get_expr(c.conbin, c.conrelid) INTO reason_expr
  FROM pg_constraint c
  WHERE c.conrelid = 'public.post_reports'::regclass
    AND c.conname = 'post_reports_reason_check'
    AND c.contype = 'c';

  IF reason_expr IS NULL THEN
    RAISE EXCEPTION 'reason CHECK expression is not available';
  END IF;

  EXECUTE format($q$
    SELECT array_agg((%s) ORDER BY t.idx)
    FROM (VALUES
      (1, 'abc'::text),
      (2, ''::text),
      (3, repeat(' ', 5)),
      (4, repeat('a', 1000)),
      (5, repeat('a', 1001)),
      (6, ' a '::text)
    ) AS t(idx, reason)
  $q$, reason_expr) INTO results;

  IF results IS DISTINCT FROM ARRAY[true, false, false, true, false, true] THEN
    RAISE EXCEPTION
      'reason CHECK does not enforce btrim length between 1 and 1000: %', results;
  END IF;

  -- (b) Policy predicates, evaluated as authenticated with a simulated uid.
  SELECT pg_get_expr(p.polqual, p.polrelid) INTO select_expr
  FROM pg_policy p
  WHERE p.polrelid = 'public.post_reports'::regclass
    AND p.polname = 'post_reports_select_own';

  SELECT pg_get_expr(p.polwithcheck, p.polrelid) INTO insert_expr
  FROM pg_policy p
  WHERE p.polrelid = 'public.post_reports'::regclass
    AND p.polname = 'post_reports_insert_own';

  IF select_expr IS NULL OR insert_expr IS NULL THEN
    RAISE EXCEPTION 'policy expressions are not available';
  END IF;

  PERFORM set_config(
    'request.jwt.claims', json_build_object('sub', v_other)::text, true
  );
  PERFORM set_config('request.jwt.claim.sub', v_other::text, true);

  IF auth.uid() IS DISTINCT FROM v_other THEN
    RAISE NOTICE
      'post_reports policy tests skipped: auth.uid() does not follow request.jwt.claims here';
  ELSE
    -- SELECT reads only the reporter's own rows.
    EXECUTE format($q$
      SELECT array_agg((%s) ORDER BY t.idx)
      FROM (VALUES (1, %L::uuid), (2, %L::uuid)) AS t(idx, reporter_id)
    $q$, select_expr, v_other, v_missing) INTO results;

    IF results IS DISTINCT FROM ARRAY[true, false] THEN
      RAISE EXCEPTION
        'SELECT policy does not restrict reads to reporter_id = auth.uid(): %', results;
    END IF;

    -- The post used for the INSERT tests must belong to someone other than the
    -- simulated reporter, otherwise the "own post is rejected" case would be
    -- indistinguishable from the "another user's post is accepted" case.
    SELECT post.id, post.user_id INTO v_post, v_author
    FROM public.posts AS post
    WHERE post.user_id IS NOT NULL
      AND post.user_id <> v_other
    ORDER BY post.id
    LIMIT 1;

    IF v_post IS NULL THEN
      RAISE NOTICE
        'post_reports INSERT policy tests skipped: public.posts has no post owned by a user other than the simulated reporter';
    ELSE
      -- Another user's existing post is accepted.
      EXECUTE format($q$
        SELECT (%s)
        FROM (VALUES (%L::uuid, %L::uuid)) AS post_reports(post_id, reporter_id)
      $q$, insert_expr, v_post, v_other) INTO verdict;

      IF verdict IS DISTINCT FROM true THEN
        RAISE EXCEPTION
          'INSERT policy rejects reporting another user''s existing post';
      END IF;

      -- A post that does not exist is rejected.
      EXECUTE format($q$
        SELECT (%s)
        FROM (VALUES (%L::uuid, %L::uuid)) AS post_reports(post_id, reporter_id)
      $q$, insert_expr, v_missing, v_other) INTO verdict;

      IF verdict IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'INSERT policy accepts a non-existent post';
      END IF;

      -- A forged reporter_id is rejected.
      EXECUTE format($q$
        SELECT (%s)
        FROM (VALUES (%L::uuid, %L::uuid)) AS post_reports(post_id, reporter_id)
      $q$, insert_expr, v_post, v_third) INTO verdict;

      IF verdict IS DISTINCT FROM false THEN
        RAISE EXCEPTION
          'INSERT policy accepts a reporter_id different from auth.uid()';
      END IF;

      -- Reporting the viewer's own post is rejected.
      PERFORM set_config(
        'request.jwt.claims', json_build_object('sub', v_author)::text, true
      );
      PERFORM set_config('request.jwt.claim.sub', v_author::text, true);

      EXECUTE format($q$
        SELECT (%s)
        FROM (VALUES (%L::uuid, %L::uuid)) AS post_reports(post_id, reporter_id)
      $q$, insert_expr, v_post, v_author) INTO verdict;

      IF verdict IS DISTINCT FROM false THEN
        RAISE EXCEPTION
          'INSERT policy accepts reporting the viewer''s own post';
      END IF;
    END IF;
  END IF;

  PERFORM set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  PERFORM set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
END
$$;
