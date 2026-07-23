-- 外部入口与身份绑定下线：系统只保留企业 OTP 登录。
-- 外部绑定身份与一次性绑定交易一并移除；企业主身份（登录授权键）保留。
DROP TABLE IF EXISTS identity_link_transactions;
DELETE FROM user_access_identities WHERE identity_kind = 'linked_external';
