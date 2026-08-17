-- Creates the 4 real partner records and their dual-username logins.
-- Safe to re-run: skips anything that already exists (matched by partner
-- name for partners, and by username for logins), so running this twice
-- won't create duplicates or overwrite a password someone has already changed.
--
-- Passwords are the exact temporary ones already shared with each partner —
-- this script does not change them. Whoever logs in first (using either
-- name of their pair) will be forced to set their own permanent password.

-- 1. Partner records
INSERT INTO partners (name)
SELECT 'Srijita' WHERE NOT EXISTS (SELECT 1 FROM partners WHERE name = 'Srijita');
INSERT INTO partners (name)
SELECT 'Tamashi' WHERE NOT EXISTS (SELECT 1 FROM partners WHERE name = 'Tamashi');
INSERT INTO partners (name)
SELECT 'Moumita' WHERE NOT EXISTS (SELECT 1 FROM partners WHERE name = 'Moumita');
INSERT INTO partners (name)
SELECT 'Enakshi' WHERE NOT EXISTS (SELECT 1 FROM partners WHERE name = 'Enakshi');

-- 2. Dual-username logins, each linked to their partner record, role = Partner
INSERT INTO users (username, username_alt, password_hash, display_name, role_id, partner_id, active, must_change_password)
SELECT 'srijita', 'soumya', '$2a$10$HjdZlcL5ob76PAIloCsjwukaaKTZOWoMmopNd1fjDhdSQm8cH4FzS',
       'Srijita / Soumya', (SELECT id FROM roles WHERE name = 'Partner'), (SELECT id FROM partners WHERE name = 'Srijita'), true, true
WHERE NOT EXISTS (SELECT 1 FROM users WHERE username = 'srijita' OR username_alt = 'srijita');

INSERT INTO users (username, username_alt, password_hash, display_name, role_id, partner_id, active, must_change_password)
SELECT 'tamashi', 'ananda', '$2a$10$BULiEe6shKT20dB.yDHVLuImDNs3/iYUsgRcqVlclSPhMlWL0r9/e',
       'Tamashi / Ananda', (SELECT id FROM roles WHERE name = 'Partner'), (SELECT id FROM partners WHERE name = 'Tamashi'), true, true
WHERE NOT EXISTS (SELECT 1 FROM users WHERE username = 'tamashi' OR username_alt = 'tamashi');

INSERT INTO users (username, username_alt, password_hash, display_name, role_id, partner_id, active, must_change_password)
SELECT 'moumita', 'anindya', '$2a$10$ATEqzc82AuPbzIvKCclCQusOgHYBdDVqt1ocq.ZM4VcWhnRvfP.oe',
       'Moumita / Anindya', (SELECT id FROM roles WHERE name = 'Partner'), (SELECT id FROM partners WHERE name = 'Moumita'), true, true
WHERE NOT EXISTS (SELECT 1 FROM users WHERE username = 'moumita' OR username_alt = 'moumita');

INSERT INTO users (username, username_alt, password_hash, display_name, role_id, partner_id, active, must_change_password)
SELECT 'enakshi', 'sabuj', '$2a$10$kU7yUxzxzrxzf3YTkQ50xutsrYIWk6S4d24VUqlrMNSljN/QYlsBe',
       'Enakshi / Sabuj', (SELECT id FROM roles WHERE name = 'Partner'), (SELECT id FROM partners WHERE name = 'Enakshi'), true, true
WHERE NOT EXISTS (SELECT 1 FROM users WHERE username = 'enakshi' OR username_alt = 'enakshi');