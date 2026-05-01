-- ============================================================================
-- SIAP Studi — Universities table + seed data
-- Run this AFTER schema.sql. In Supabase dashboard: SQL Editor → paste → Run.
-- ============================================================================

-- 1) Table
create table if not exists public.universities (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  short_name text,
  country text,
  location text not null check (location in ('indonesia', 'luar_negeri')),
  created_at timestamptz default now()
);

create index if not exists universities_location_idx on public.universities(location);
create unique index if not exists universities_name_unique on public.universities(name);

-- 2) Public read (everyone can list universities)
alter table public.universities enable row level security;

drop policy if exists "universities_public_read" on public.universities;
create policy "universities_public_read" on public.universities for select using (true);

-- 3) Extend essays table with new columns (safe if already run)
alter table public.essays add column if not exists degree_level text;
alter table public.essays add column if not exists university_location text;
alter table public.essays add column if not exists university_id uuid references public.universities(id);
alter table public.essays add column if not exists university_name text;
alter table public.essays add column if not exists coverage jsonb;
alter table public.essays add column if not exists language text;

-- 4) Seed — Indonesian universities
insert into public.universities (name, short_name, country, location) values
  ('Universitas Indonesia', 'UI', 'Indonesia', 'indonesia'),
  ('Institut Teknologi Bandung', 'ITB', 'Indonesia', 'indonesia'),
  ('Universitas Gadjah Mada', 'UGM', 'Indonesia', 'indonesia'),
  ('IPB University', 'IPB', 'Indonesia', 'indonesia'),
  ('Institut Teknologi Sepuluh Nopember', 'ITS', 'Indonesia', 'indonesia'),
  ('Universitas Airlangga', 'Unair', 'Indonesia', 'indonesia'),
  ('Universitas Padjadjaran', 'Unpad', 'Indonesia', 'indonesia'),
  ('Universitas Diponegoro', 'Undip', 'Indonesia', 'indonesia'),
  ('Universitas Brawijaya', 'UB', 'Indonesia', 'indonesia'),
  ('Universitas Sebelas Maret', 'UNS', 'Indonesia', 'indonesia'),
  ('Universitas Hasanuddin', 'Unhas', 'Indonesia', 'indonesia'),
  ('Universitas Sumatera Utara', 'USU', 'Indonesia', 'indonesia'),
  ('Universitas Andalas', 'Unand', 'Indonesia', 'indonesia'),
  ('Universitas Sriwijaya', 'Unsri', 'Indonesia', 'indonesia'),
  ('Universitas Negeri Yogyakarta', 'UNY', 'Indonesia', 'indonesia'),
  ('Universitas Pendidikan Indonesia', 'UPI', 'Indonesia', 'indonesia'),
  ('Universitas Negeri Jakarta', 'UNJ', 'Indonesia', 'indonesia'),
  ('Universitas Telkom', 'Tel-U', 'Indonesia', 'indonesia'),
  ('BINUS University', 'BINUS', 'Indonesia', 'indonesia'),
  ('Universitas Islam Indonesia', 'UII', 'Indonesia', 'indonesia'),
  ('Universitas Syiah Kuala', 'USK', 'Indonesia', 'indonesia'),
  ('Universitas Udayana', 'Unud', 'Indonesia', 'indonesia'),
  ('Universitas Mulawarman', 'Unmul', 'Indonesia', 'indonesia'),
  ('Universitas Lampung', 'Unila', 'Indonesia', 'indonesia'),
  ('Universitas Jember', 'Unej', 'Indonesia', 'indonesia')
on conflict (name) do nothing;

-- 5) Seed — International universities (LPDP top destinations)
insert into public.universities (name, short_name, country, location) values
  ('Massachusetts Institute of Technology', 'MIT', 'USA', 'luar_negeri'),
  ('Harvard University', 'Harvard', 'USA', 'luar_negeri'),
  ('Stanford University', 'Stanford', 'USA', 'luar_negeri'),
  ('University of California, Berkeley', 'UC Berkeley', 'USA', 'luar_negeri'),
  ('Columbia University', 'Columbia', 'USA', 'luar_negeri'),
  ('Cornell University', 'Cornell', 'USA', 'luar_negeri'),
  ('University of Michigan', 'UMich', 'USA', 'luar_negeri'),
  ('Carnegie Mellon University', 'CMU', 'USA', 'luar_negeri'),
  ('University of Oxford', 'Oxford', 'UK', 'luar_negeri'),
  ('University of Cambridge', 'Cambridge', 'UK', 'luar_negeri'),
  ('Imperial College London', 'Imperial', 'UK', 'luar_negeri'),
  ('University College London', 'UCL', 'UK', 'luar_negeri'),
  ('London School of Economics', 'LSE', 'UK', 'luar_negeri'),
  ('King''s College London', 'KCL', 'UK', 'luar_negeri'),
  ('University of Edinburgh', 'Edinburgh', 'UK', 'luar_negeri'),
  ('University of Manchester', 'Manchester', 'UK', 'luar_negeri'),
  ('University of Warwick', 'Warwick', 'UK', 'luar_negeri'),
  ('University of Nottingham', 'Nottingham', 'UK', 'luar_negeri'),
  ('Delft University of Technology', 'TU Delft', 'Netherlands', 'luar_negeri'),
  ('Wageningen University & Research', 'WUR', 'Netherlands', 'luar_negeri'),
  ('University of Amsterdam', 'UvA', 'Netherlands', 'luar_negeri'),
  ('Utrecht University', 'Utrecht', 'Netherlands', 'luar_negeri'),
  ('Leiden University', 'Leiden', 'Netherlands', 'luar_negeri'),
  ('Erasmus University Rotterdam', 'Erasmus', 'Netherlands', 'luar_negeri'),
  ('ETH Zurich', 'ETHZ', 'Switzerland', 'luar_negeri'),
  ('EPFL', 'EPFL', 'Switzerland', 'luar_negeri'),
  ('Technical University of Munich', 'TUM', 'Germany', 'luar_negeri'),
  ('Heidelberg University', 'Heidelberg', 'Germany', 'luar_negeri'),
  ('RWTH Aachen University', 'RWTH Aachen', 'Germany', 'luar_negeri'),
  ('Humboldt University of Berlin', 'HU Berlin', 'Germany', 'luar_negeri'),
  ('National University of Singapore', 'NUS', 'Singapore', 'luar_negeri'),
  ('Nanyang Technological University', 'NTU', 'Singapore', 'luar_negeri'),
  ('University of Melbourne', 'Melbourne', 'Australia', 'luar_negeri'),
  ('Australian National University', 'ANU', 'Australia', 'luar_negeri'),
  ('University of Sydney', 'USyd', 'Australia', 'luar_negeri'),
  ('University of New South Wales', 'UNSW', 'Australia', 'luar_negeri'),
  ('University of Queensland', 'UQ', 'Australia', 'luar_negeri'),
  ('Monash University', 'Monash', 'Australia', 'luar_negeri'),
  ('University of Tokyo', 'UTokyo', 'Japan', 'luar_negeri'),
  ('Kyoto University', 'Kyoto-U', 'Japan', 'luar_negeri'),
  ('Tohoku University', 'Tohoku', 'Japan', 'luar_negeri'),
  ('Osaka University', 'Osaka-U', 'Japan', 'luar_negeri'),
  ('KAIST', 'KAIST', 'South Korea', 'luar_negeri'),
  ('Seoul National University', 'SNU', 'South Korea', 'luar_negeri'),
  ('Tsinghua University', 'Tsinghua', 'China', 'luar_negeri'),
  ('Peking University', 'PKU', 'China', 'luar_negeri'),
  ('The University of Hong Kong', 'HKU', 'Hong Kong', 'luar_negeri'),
  ('McGill University', 'McGill', 'Canada', 'luar_negeri'),
  ('University of Toronto', 'UofT', 'Canada', 'luar_negeri'),
  ('University of British Columbia', 'UBC', 'Canada', 'luar_negeri')
on conflict (name) do nothing;
