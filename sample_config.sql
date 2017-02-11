UPDATE pool.config SET item_value = '' WHERE module = 'pool' and item = 'address';
UPDATE pool.config SET item_value = '' WHERE module = 'pool' and item = 'feeAddress';
UPDATE pool.config SET item_value = '' WHERE module = 'general' and item = 'mailgunKey';
UPDATE pool.config SET item_value = '' WHERE module = 'general' and item = 'mailgunURL';
UPDATE pool.config SET item_value = '' WHERE module = 'general' and item = 'emailFrom';
UPDATE pool.config SET item_value = '' WHERE module = 'general' and item = 'shareHost';