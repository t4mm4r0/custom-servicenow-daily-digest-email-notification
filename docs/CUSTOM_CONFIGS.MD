# Tables

## u_daily_digest_preference

Stores per user digest settings, whether digest is enabled and when the last digest was sent. Needed to control opt-in/opt-out and avoid sending more than once per day.

Columns:

- **u_user** (Reference -> sys_user) **[unique index]**
- **u_enabled** (Boolean, default false)
- **u_last_sent** (Date/Time, nullable)

ACL Rules:

- Type: **record**
- Operation: **read** (every field), **write** (only on **u_enabled** field) -> TBR
- Name: **u_daily_digest_preference**
- Advanced Script:

```javascript
// needed to enable daily digest for the current user (they can only edit their own preference)
current.u_user == gs.getUserID();
```

## u_daily_digest_item

Stores the queued digest content: opened, assigned, closed and comment items for each recipient. Needed to collect activity over time before sending the digest.

Columns:

- **u_recipient** (Reference -> sys_user) **[normal index]**
- **u_type** (Choice: opened, assigned, closed, comment)
- **u_table** (String)
- **u_record_sys_id** (String 32)
- **u_record_number** (String)
- **u_short_description** (String 160)
- **u_state_display** (String 80)
- **u_occurred_at** (Date/Time) **[normal index]**
- **u_count** (Integer, default 1) *for comment aggregation*
- **u_last_actor_name** (String 80)
- **u_last_comment_preview** (String 255)
- **u_processed** (Boolean, default false) **[normal index]**
- **u_processed_on** (Date/Time)
- **u_digest_run** (Reference -> u_daily_digest_run) **[normal index]**
- **u_unique_key** (String 200) *to dedupe/aggregate* **[unique index]**
- **u_record_link** (URL, read-only, advanced calculated value) *to calculate the link of the corresponding record*

```javascript
(function calculatedFieldValue(current) {
    if (!current.u_table || !current.u_record_sys_id) {
		return '';
	}

    return '/nav_to.do?uri=' + current.u_table + '.do?sys_id=' + current.u_record_sys_id;
})(current);
```

ACL Rule:

- Type: **record**
- Operation: **read**
- Name: **u_daily_digest_item**
- Advanced Script:

```javascript
// needed to allow reading only user own rows on u_daily_digest_item table in case of "show more" link in the email
current.u_recipient == gs.getUserID();
```

## u_daily_digest_run

Stores one actual digest send attempt for one user over one time window. Needed to group claimed items, trigger the notification, track status, and handle success, failure or retry send.

Columns:

- **u_user** (Reference -> sys_user) **[normal index]**
- **u_since** (Date/Time)
- **u_until** (Date/Time)
- **u_item_count** (Integer)
- **u_status** (Choice: ready, queued, sent, error) **[normal index]**
- **u_sent_on** (Date/Time)
- **u_error_message** (String 1000)
- **sys_created_on** (Date/Time) *default table field* **[normal index]**

# System Properties

They store: comma separated list of tables and of journal field types the daily digest should include; default daily local send time for user's digest; how long a run can stay in *ready* or *queued* status before being treated as stale and recovered.

- **daily_digest.source_tables** = incident,problem,sc_req_item
- **daily_digest.journal_element_types** = comments
- **daily_digest.default_send_time** = 17:00:00
- **daily_digest.queue_timeout_minutes** = 120

# Script Includes

Shared server-side logic used to avoid duplicated code and organize complex logic better within the implementation. **Business Rules** call **DailyDigestQueue**, **Scheduler Job** calls **DailyDigestScheduler** and **Mail Script** calls **DailyDigestEmailBuilder**. **DailyDigestConfig** is called in multiple places to retrieve stored configs.

| Name | Description |
| ------ | ------ |
| **DailyDigestConfig** | Reads system properties, parses them, and provides shared config values like source tables, journal types, send time, timeout, and base URL. |
| **DailyDigestQueue** | Used to "catch" activities via Business Rules and to create or aggregate rows in the **u_daily_digest_item** table. |
| **DailyDigestScheduler** | Finds candidate daily digest users, creates daily digest runs, links queued items to runs, finalizes successful runs, and recovers failed ones. |
| **DailyDigestEmailBuilder** | Takes one digest run and builds the final email subject and HTML body from linked digest items adding also pending approvals. |

# Business Rules

The **DigestCatcher Business Rules** capture activities from records and turn them into queued digest items. They catch when supported records are **opened**, **assigned** or **closed** and when **new comments** are added. Then they call **DailyDigestQueue** which creates or updates rows in the **u_daily_digest_item** custom table.

The **DigestDelivery Business Rule** detects that the digest email was really sent and mark the related digest run items as successfully processed. It waits until the outbound email becomes **type = sent**, calls **markRunSentFromEmail()** from **DailyDigestScheduler** that finds which digest run the email belongs to and then finalizes that run.

## [DigestCatcher] Incident Opened

- Table: **incident**
- When to run: **after insert**
- Advanced script:

```javascript
(function executeRule(current, previous) {
	var queue = new DailyDigestQueue();
	queue.queueCaseOpened(current);
})(current, previous);
```

## [DigestCatcher] Problem Opened

- Table: **problem**
- When to run: **after insert**
- Advanced script:

```javascript
(function executeRule(current, previous) {
	var queue = new DailyDigestQueue();
	queue.queueCaseOpened(current);
})(current, previous);
```

## [DigestCatcher] Req. Item Opened

- Table: **sc_req_item**
- When to run: **after insert**
- Advanced script:

```javascript
(function executeRule(current, previous) {
	var queue = new DailyDigestQueue();
	queue.queueCaseOpened(current);
})(current, previous);
```

## [DigestCatcher] Incident Assigned/Closed

- Table: **incident**
- When to run: **after update**
- Advanced script:

```javascript
(function executeRule(current, previous) {
	var queue = new DailyDigestQueue();
	queue.queueCaseAssigned(current);
	queue.queueCaseClosed(current);
})(current, previous);
```

## [DigestCatcher] Problem Assigned/Closed

- Table: **problem**
- When to run: **after update**
- Advanced script:

```javascript
(function executeRule(current, previous) {
	var queue = new DailyDigestQueue();
	queue.queueCaseAssigned(current);
	queue.queueCaseClosed(current);
})(current, previous);
```

## [DigestCatcher] Req. Item Assigned/Closed

- Table: **sc_req_item**
- When to run: **after update**
- Advanced script:

```javascript
(function executeRule(current, previous) {
	var queue = new DailyDigestQueue();
	queue.queueCaseAssigned(current);
	queue.queueCaseClosed(current);
})(current, previous);
```

## [DigestCatcher] New Comments

- Table: **sys_journal_field**
- When to run: **after insert**
- Advanced script:

```javascript
(function executeRule(current, previous) {
	var queue = new DailyDigestQueue();
	queue.queueJournalElement(current);
})(current, previous);
```

## [DigestDelivery] Mark Run Sent From Outbound Email

- Table: **sys_email**
- When to run: **after insert** and **after update**
- Advanced script:

```javascript
(function executeRule(current, previous) {
    // read the current value of sys_email.type
	var currentType = current.getValue('type');

    // if sys_email.type is not "sent" do nothing
	if (currentType !== 'sent') {
		return;
	}

    // if previous exists and was already "sent" before stop to avoid running the finalization logic more than once
	if (previous && previous.getValue('type') === 'sent') {
		return;
	}

    // if sys_email.type is "sent" invoke the DailyDigestScheduler script include to:
	// 1) extract the embedded digest run token from the email
	// 2) find the matching u_daily_digest_run row with that token
	// 3) finalize that run as successfully sent and mark the associated items as processed
	new DailyDigestScheduler().markRunSentFromEmail(current);
})(current, previous);
```

# Scheduled Script Execution

## Daily Digest Scheduler Runner

It is the scheduled job that launches the daily digest workflow. Its job is to recover failed queued runs, find users who may need a daily digest, process those users and create digest runs when eligible.

- Run: **Every 30 Minutes**
- Script:

```javascript
(function() {
	new DailyDigestScheduler().digestRun();
})();
```

## Daily Digest Cleanup

It is the scheduled job that cleanes the old records from the **u_daily_digest_item** and **u_daily_digest_run** tables.

- Run: **Daily at 02:00 UTC**
- Script:

```javascript
(function() {
	// delete one year old records
	var cutoff = new GlideDateTime();
	cutoff.addDaysUTC(-365);

	// delete old "processed" digest items only
	var itemGR = new GlideRecord('u_daily_digest_item');
	itemGR.addQuery('sys_created_on', '<', cutoff);
	itemGR.addQuery('u_processed', true);
	itemGR.query();
	itemGR.deleteMultiple();

	// delete old "sent" or "error" digest runs only
	var runGR = new GlideRecord('u_daily_digest_run');
	runGR.addQuery('sys_created_on', '<', cutoff);
	runGR.addQuery('u_status', 'IN', 'sent,error');
	runGR.query();
	runGR.deleteMultiple();
})();
```

# Event

It is the bridge between run creation and email sending. It is fired on a **u_daily_digest_run** record by the scheduler with: **gs.eventQueue()**.

- Name: **daily_digest.send**
- Table: **u_daily_digest_run**

# Email Notification

It is the component that turns the digest run event into the actual outgoing email. It actually sends the digest email when the event is fired. It listens for the event **daily_digest.send** (based on the table **u_daily_digest_run**), sends to the user in the field **u_user**, uses the mail script **daily_digest_body** to build the body HTML content.

- Name: **Custom Daily Digest Email Notification**
- Table: **u_daily_digest_run**
- Who will receive: **Users/Groups in fields -> u_user**
- When to send: **Event is fired -> daily_digest.send**
- Content type: **HTML only**
- Message HTML:

```text
${mail_script:daily_digest_body}
```

# Email Script

It builds the actual content of the daily digest email. It invokes the **DailyDigestEmailBuilder**, calls **buildMail()** on the current **u_daily_digest_run**, sets the email subject and prints the HTML body into the notification. If something fails, it marks the run as failed and prints a fallback message.

- Name: **daily_digest_body**
- Script:

```javascript
(function runMailScript(current, template, email, email_action, event) {
    // invoke the helper responsible for building the digest email content
	var builder = new DailyDigestEmailBuilder();

    // invoke the scheduler helper to mark the run as failed if the email content generation throws an error
	var scheduler = new DailyDigestScheduler();

	try {
        // build the mail content object from the current digest run record
		// example:
		// {
		//   subject: 'Your daily digest - ...',
		//   html: '<div>...</div>'
		// }
		var out = builder.buildMail(current);

        // if a valid subject is returned use it as the outgoing email subject
		if (out && out.subject) {
			email.setSubject(out.subject);
		}

        // if a valid HTML body is returned print it into the notification body
		if (out && out.html) {
            template.print(out.html);
        
        // otherwise print an empty string so the email body is still valid
        } else {
            template.print('');
        }
	} catch (error) {
        // if email generation fails mark the current digest run as failed so its linked items can be released back for retry
		scheduler.failRun(current, error);

        // write an error to the system log for potential troubleshooting
		gs.error('[CustomDailyDigest] Email build failed for run ' + current.getUniqueValue() + ': ' + error);

        // set a fallback subject for the failed email content generation case
		email.setSubject('Daily summary unavailable!');

        // print a fallback body so the notification still has a valid output
		template.print('Unable to build daily digest. The run has been released for retry.');
	}
})(current, template, email, email_action, event);
```

# UI Page

## Daily Digest Unsub Page

Page which opens when a user clicks on the "Unsub" link in the daily digest email.

Name: **daily_digest_unsubscribe**
HTML body:

```javascript
<?xml version="1.0" encoding="utf-8" ?>
<j:jelly trim="false" xmlns:j="jelly:core" xmlns:g="glide">
	<g:evaluate>
		var userId = gs.getUserID();
		var message = '';

		if (!userId || userId == 'guest') {
			message = 'Please sign in to disable your daily digest.';
		} else {
			var pref = new GlideRecord('u_daily_digest_preference');
			pref.addQuery('u_user', userId);
			pref.setLimit(1);
			pref.query();

			if (pref.next()) {
				pref.setValue('u_enabled', false);
				pref.update();
			} else {
				pref.initialize();
				pref.setValue('u_user', userId);
				pref.setValue('u_enabled', false);
				pref.insert();
			}

			message = 'Your daily digest has been disabled.';
		}
	</g:evaluate>

	<html>
		<body>
			<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#111;padding:24px">
				<h2 style="margin:0 0 8px 0">Daily digest</h2>
				<div>${message}</div>
			</div>
		</body>
	</html>
</j:jelly>
```