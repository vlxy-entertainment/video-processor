-- TikTok Accounts Import SQL
-- Generated from WFLZFB1TTK.txt
-- Total accounts: 7

INSERT INTO tiktok_accounts (name, aadvid, sid_guard_ads, csrftoken, status) VALUES (
  'user7903700966255',
  'LWTwgBzwN',
  'e93531ef436b4791a8067991b04e29b9%7C1754897268%7C15551994%7CSat%2C+07-Feb-2026+07%3A27%3A42+GMT',
  'pfBzdZJZ-k0muhE6qUQouefusyVB3tInXncA',
  'active'
) ON CONFLICT (aadvid) DO UPDATE SET
  sid_guard_ads = EXCLUDED.sid_guard_ads,
  csrftoken = EXCLUDED.csrftoken,
  updated_at = NOW();

INSERT INTO tiktok_accounts (name, aadvid, sid_guard_ads, csrftoken, status) VALUES (
  'user6879484302280',
  'beUrrAEQ',
  'c32ffa14f37cab7ebd7be634e213cc4b%7C1754738864%7C15551999%7CThu%2C+05-Feb-2026+11%3A27%3A43+GMT',
  'xQ9AAv8h-iyxVL3D6oLMpLMp7LNvqn935qjE',
  'active'
) ON CONFLICT (aadvid) DO UPDATE SET
  sid_guard_ads = EXCLUDED.sid_guard_ads,
  csrftoken = EXCLUDED.csrftoken,
  updated_at = NOW();

INSERT INTO tiktok_accounts (name, aadvid, sid_guard_ads, csrftoken, status) VALUES (
  'user8324378657993',
  'fFxUH1jh',
  '779441eb2adf23597b23e723a58c3741%7C1754722872%7C15551994%7CThu%2C+05-Feb-2026+07%3A01%3A06+GMT',
  'pg5Xa4Kz-Iy_Y2Eh0Qe8ZdWLlVAFye3yORLo',
  'active'
) ON CONFLICT (aadvid) DO UPDATE SET
  sid_guard_ads = EXCLUDED.sid_guard_ads,
  csrftoken = EXCLUDED.csrftoken,
  updated_at = NOW();

INSERT INTO tiktok_accounts (name, aadvid, sid_guard_ads, csrftoken, status) VALUES (
  'user479831265600',
  'qpYeH6uYi',
  'd821be1f287b2f154e9875b04992f79f%7C1754837347%7C15551994%7CFri%2C+06-Feb-2026+14%3A49%3A01+GMT',
  '2sgFiD2A-KURW6cxljCJCMXk-tswss_q2hzs',
  'active'
) ON CONFLICT (aadvid) DO UPDATE SET
  sid_guard_ads = EXCLUDED.sid_guard_ads,
  csrftoken = EXCLUDED.csrftoken,
  updated_at = NOW();

INSERT INTO tiktok_accounts (name, aadvid, sid_guard_ads, csrftoken, status) VALUES (
  'user30125595525301',
  '22a44y5bjN',
  'ef02dd11ad709d417eeb9c4b99fe6704%7C1754807273%7C15551994%7CFri%2C+06-Feb-2026+06%3A27%3A47+GMT',
  'NPnr6w9U-RHyI5ZrKsAk_ByKW1IGcX2lfXxg',
  'active'
) ON CONFLICT (aadvid) DO UPDATE SET
  sid_guard_ads = EXCLUDED.sid_guard_ads,
  csrftoken = EXCLUDED.csrftoken,
  updated_at = NOW();

INSERT INTO tiktok_accounts (name, aadvid, sid_guard_ads, csrftoken, status) VALUES (
  'user8228163974903',
  'uVRG3LlMXj1',
  '3ab850bb46499fab42951468c14e86e5%7C1754853261%7C15551991%7CFri%2C+06-Feb-2026+19%3A14%3A12+GMT',
  '1lNn6p6Y-VWQzkOdZOPDKpejj4b89QHJRQOs',
  'active'
) ON CONFLICT (aadvid) DO UPDATE SET
  sid_guard_ads = EXCLUDED.sid_guard_ads,
  csrftoken = EXCLUDED.csrftoken,
  updated_at = NOW();

INSERT INTO tiktok_accounts (name, aadvid, sid_guard_ads, csrftoken, status) VALUES (
  'user92207798627780',
  '4rALQJgvPkr1',
  '4e1b5f3be5f1ea0c6e7636eaf3f1a142%7C1754861769%7C15551994%7CFri%2C+06-Feb-2026+21%3A36%3A03+GMT',
  'c19PsGyT-y1sRCXfhOkqDYgTly6cNfQuDI_w',
  'active'
) ON CONFLICT (aadvid) DO UPDATE SET
  sid_guard_ads = EXCLUDED.sid_guard_ads,
  csrftoken = EXCLUDED.csrftoken,
  updated_at = NOW();
