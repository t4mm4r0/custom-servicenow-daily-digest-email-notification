// script include responsible for finding users who need daily digest, creating digest runs, linking queued items to a run, finalizing runs once the email is sent and recovering stale runs if delivery fails or times out
var DailyDigestScheduler = Class.create();

DailyDigestScheduler.prototype = {
	initialize: function () {
		// load the config helper to read properties
		this.config = new DailyDigestConfig();

		// regex used to find the embedded run token in outbound email content
		// needed to correctly finalize runs inside the u_daily_digest_run table 
		// this allows to mark as sent only successful runs where the email has actually been delivered
		// example: DAILY_DIGEST_RUN:1234567890abcdef1234567890abcdef
		this.runTokenPattern = /DAILY_DIGEST_RUN:([0-9a-f]{32})/i;
	},

	// ***************************************
	// *** UTILITY FUNCTIONS SECTION START ***
	// ***************************************

	// utility function to extract a run token from arbitrary text using the regex defined in the constructor
	extractRunIDFromText: function (text) {
		// convert input to a string
		var value = (text || '') + '';
		if (!value) {
			return '';
		}

		// execute regex match
		var match = value.match(this.runTokenPattern);

		// if no valid match or capture group exists return blank
		if (!match || !match[1]) {
			return '';
		}

		// convert the found run token to lowercase and return it
		return (match[1] + '').toLowerCase();
	},

	// utility function to search several possible sys_email fields for the embedded run token
	extractRunIDFromEmail: function (emailGR) {
		// list of candidate fields to inspect
		var fields = ['body_html', 'body_text', 'body', 'subject'];

		// loop through each field
		for (var i = 0; i < fields.length; i++) {
			var fieldName = fields[i];

			// skip fields not present in the current sys_email
			if (!emailGR.isValidField(fieldName)) {
				continue;
			}

			// try extracting the run token from the current field content
			var token = this.extractRunIDFromText(emailGR.getValue(fieldName));
			if (token) {
				return token;
			}
		}

		// if no run token is found return an empty string
		return '';
	},

	// utility function to convert input into a run sys_id
	// accepts either a GlideRecord with getUniqueValue() or a raw sys_id string
	getRunID: function (runOrSysID) {
		if (runOrSysID && typeof runOrSysID.getUniqueValue === 'function') {
			return runOrSysID.getUniqueValue();
		}

		return (runOrSysID || '') + '';
	},

	// utility function to remove the "|claimed|..." suffix from a claimed u_unique_key
	stripClaimSuffix: function (key) {
		key = (key || '') + '';

		var idx = key.indexOf('|claimed|');
		if (idx === -1) {
			return key;
		}

		return key.substring(0, idx);
	},

	// utility function to recognize a duplicate key or unique index error
	// might not work consistently since database error text can vary
	isDuplicateKeyError: function (error) {
		// convert the error into a lowercase string for comparison
		var msg = (error || '') + '';
		msg = msg.toLowerCase();

		// return true if the message looks like a duplicate or unique key error
		return (msg.indexOf('duplicate') > -1 || msg.indexOf('unique') > -1 || msg.indexOf('u_unique_key') > -1);
	},

	// utility function to truncate a string and add an ellipsis if needed
	truncate: function (text, maxLength) {
		// convert input to string
		var value = (text || '') + '';

		// return the string as is if already short enough
		if (value.length <= maxLength) {
			return value;
		}

		// otherwise truncate and append the ellipsis chars
		return value.substring(0, maxLength - 1) + '…';
	},

	// utility function to get a user's timezone from sys_user.time_zone
	getUserTimeZoneID: function (user) {
		// get and trim the time_zone value
		var timeZone = (user.getValue('time_zone') || '');
		timeZone = timeZone.trim();

		// fallback to UTC if timezone is blank
		if (!timeZone) {
			timeZone = 'UTC';
		}

		// return the timezone value
		return timeZone;
	},

	// utility function to format a GlideDateTime in a specific timezone using a given java date pattern
	// might not work as expected in future because java package calls could be prevented
	formatInTimeZone: function (gdt, timeZone, pattern) {
		// build a java timezone object from the timezone value
		var tz = Packages.java.util.TimeZone.getTimeZone(timeZone);

		// build a java date formatter with the given pattern
		var sdf = new Packages.java.text.SimpleDateFormat(pattern);

		// apply the timezone to the formatter
		sdf.setTimeZone(tz);

		// convert the GlideDateTime into a java date format
		var javaDate = new Packages.java.util.Date(gdt.getNumericValue());

		// convert and return the date as string
		return '' + sdf.format(javaDate);
	},

	// utility function to return an object with the user's local date and local time strings
	getLocalParts: function (gdt, timeZone) {
		return {
			date: this.formatInTimeZone(gdt, timeZone, 'yyyy-MM-dd'),
			time: this.formatInTimeZone(gdt, timeZone, 'HH:mm:ss')
		};
	},

	// utility function to compute the UTC timestamp representing the start of the previous local day
	// used for first time daily digests when no last_sent field exists yet
	getStartOfPreviousLocalDayUTC: function (nowGdt, timeZone) {
		// build a timezone aware java calendar
		var tz = Packages.java.util.TimeZone.getTimeZone(timeZone);
		var cal = Packages.java.util.Calendar.getInstance(tz);

		// start from the current time
		cal.setTimeInMillis(nowGdt.getNumericValue());

		// snap to local midnight
		cal.set(Packages.java.util.Calendar.HOUR_OF_DAY, 0);
		cal.set(Packages.java.util.Calendar.MINUTE, 0);
		cal.set(Packages.java.util.Calendar.SECOND, 0);
		cal.set(Packages.java.util.Calendar.MILLISECOND, 0);

		// move one local day backward
		cal.add(Packages.java.util.Calendar.DATE, -1);

		// Convert back into a GlideDateTime
		var since = new GlideDateTime();
		since.setNumericValue(cal.getTimeInMillis());
		return since;
	},

	// utility function to fetch the user's preferences from the u_daily_digest_preference table
	// if no preferences are found for the user they are created on demand
	getOrCreatePref: function (user) {
		// query u_daily_digest_preference by unique u_user value (reference to sys_user.sys_id)
		var digestPref = new GlideRecord('u_daily_digest_preference');
		digestPref.addQuery('u_user', user.getUniqueValue());
		digestPref.setLimit(1);
		digestPref.query();

		// if found return the existing preferences row of the user
		if (digestPref.next()) {
			return digestPref;
		}

		// otherwise initialize a new preferences row for the user
		digestPref.initialize();

		// link the new preferences row to the user
		digestPref.setValue('u_user', user.getUniqueValue());

		// by default the custom daily digest is set as disabled for the user
		digestPref.setValue('u_enabled', false);

		try {
			// try to insert the new preferences row
			var newPrefID = digestPref.insert();

			// reload the record that was just inserted
			digestPref.get(newPrefID);

			// return the new inserted record
			return digestPref;
		} catch (error) {
			// this block is to gracefully recover from a race condition to create the same preferences row
			// query again and return the race winner if it now exists
			var retry = new GlideRecord('u_daily_digest_preference');
			retry.addQuery('u_user', user.getUniqueValue());
			retry.setLimit(1);
			retry.query();

			if (retry.next()) {
				return retry;
			}

			// if still not found throw the original error
			throw error;
		}
	},

	// utility function to create a new digest run row in the u_daily_digest_run table
	// a run represents one email delivery attempt for one user over one well defined time window
	createRun: function (user, since, until, totalShownCount) {
		// initialize a new run record into u_daily_digest_run
		var run = new GlideRecord('u_daily_digest_run');
		run.initialize();

		// set the recipient user
		run.setValue('u_user', user.getUniqueValue());

		// set the time window covered by this run
		run.setValue('u_since', since);
		run.setValue('u_until', until);

		// set the current precomputed count of items expected to show
		run.setValue('u_item_count', totalShownCount || 0);

		// by default new runs start with "ready" status until the event is fired and queued
		run.setValue('u_status', 'ready');

		// by default set a clear error message for newly created run
		run.setValue('u_error_message', '');

		// insert and reload the newly created run
		var runID = run.insert();
		run.get(runID);

		// return the newly created run
		return run;
	},

	// utility function to count how many daily digest entries would show for a user in the given time window
	// used before creating the run so empty daily digests are skipped
	getQueuedDigestSummary: function (userID, since, until) {
		// initialize the output object
		var out = {
			totalShown: 0
		};

		// query all unclaimed and unprocessed queued items for the user in the given time window from the u_daily_digest_item table
		var gr = new GlideRecord('u_daily_digest_item');
		gr.addNullQuery('u_digest_run');
		gr.addQuery('u_processed', false);
		gr.addQuery('u_recipient', userID);
		gr.addQuery('u_occurred_at', '>=', since);
		gr.addQuery('u_occurred_at', '<=', until);
		gr.query();

		// loop through all matching rows to compute the total display count
		while (gr.next()) {
			// read the item type
			var itemType = ((gr.getValue('u_type') || '') + '').toLowerCase().trim();

			// read and validate the comment count (u_count)
			var itemCount = parseInt(gr.getValue('u_count'), 10);
			if (isNaN(itemCount) || itemCount < 1) {
				itemCount = 1;
			}

			// "comment" aggregates type items contribute with their full comment count
			if (itemType === 'comment') {
				out.totalShown += itemCount;

				// "opened", "assigned" and "closed" type items always count as one row each
			} else if (itemType === 'opened' || itemType === 'assigned' || itemType === 'closed') {
				out.totalShown += 1;

				// if u_type is null or undefined do not increase the count
			} else {
				out.totalShown += 0;
			}
		}

		// return the final daily digest items sum
		return out;
	},

	// utility function to link currently queued daily digest items in the given time window to a newly created run
	// this "claims" the daily digest items so the email builder can read a stable set
	linkQueuedItemsToRun: function (userID, since, until, runID) {
		// query the candidate queue items to claim from the u_daily_digest_item table
		var items = new GlideRecord('u_daily_digest_item');
		items.addNullQuery('u_digest_run');
		items.addQuery('u_processed', false);
		items.addQuery('u_recipient', userID);
		items.addQuery('u_occurred_at', '>=', since);
		items.addQuery('u_occurred_at', '<=', until);
		items.orderBy('sys_created_on');
		items.query();

		// loop through every item found and "claim" it for the digest run
		while (items.next()) {
			// read the current unique key
			var currentKey = (items.getValue('u_unique_key') || '');

			// append a "claim" suffix if not already present
			// this preserves the original unique key information while making the claimed row unique
			if (currentKey.indexOf('|claimed|') === -1) {
				items.setValue('u_unique_key', currentKey + '|claimed|' + runID + '|' + items.getUniqueValue());
			}

			// link the item to the run (u_digest_run field in the u_daily_digest_item table is a reference field to the u_daily_digest_run table)
			items.setValue('u_digest_run', runID);

			// save the "claimed" row
			items.update();
		}
	},

	// utility function to count the user's currently pending approvals
	// this sum is included in the daily digest summary even though is not stored in the u_daily_digest_item table
	countPendingApprovals: function (userID) {
		// count over pending approvals (sysapproval_approver table) for the user
		var gr = new GlideAggregate('sysapproval_approver');
		gr.addQuery('approver', userID);
		gr.addQuery('state', 'requested');
		gr.addAggregate('COUNT');
		gr.query();

		// if a valid result row exists parse the count (because glide aggregate returns a string)
		if (gr.next()) {
			var countValue = parseInt(gr.getAggregate('COUNT'), 10);
			if (isNaN(countValue)) {
				return 0;
			} else {
				return countValue;
			}
		}

		// otherwise there are zero approvals pending
		return 0;
	},

	// utility function to build the set of users who might have pending daily digest items
	// a user is a candidate if they have queued daily digest items or pending approvals
	getCandidateUsers: function () {
		// initialize an object to use as a set of user ids (to avoid having duplicate of the same user id in the list)
		var candidateUsers = {};

		// first get recipients who currently have unclaimed and unprocessed daily digest items
		var dailyDigestItemGA = new GlideAggregate('u_daily_digest_item');
		dailyDigestItemGA.addNullQuery('u_digest_run');
		dailyDigestItemGA.addQuery('u_processed', false);
		dailyDigestItemGA.groupBy('u_recipient');
		dailyDigestItemGA.query();

		while (dailyDigestItemGA.next()) {
			var recipientID = dailyDigestItemGA.getValue('u_recipient');
			if (recipientID) {
				candidateUsers[recipientID] = true;
			}
		}

		// then get approvers who have pending approvals
		var sysApprGA = new GlideAggregate('sysapproval_approver');
		sysApprGA.addQuery('state', 'requested');
		sysApprGA.addNotNullQuery('approver');
		sysApprGA.groupBy('approver');
		sysApprGA.query();

		while (sysApprGA.next()) {
			var approverID = sysApprGA.getValue('approver');
			if (approverID) {
				candidateUsers[approverID] = true;
			}
		}

		// convert the object into a plain array of sys_ids
		var finalUsersList = [];
		for (var userID in candidateUsers) {
			finalUsersList.push(userID);
		}

		// return a plain array of sys_ids relative to the daily digest candidate users
		return finalUsersList;
	},

	// utility function to prevent creating duplicate active runs for the same user
	// return true if the user already has a "ready" or "queued" run
	hasOutstandingRun: function (userID) {
		var runGR = new GlideRecord('u_daily_digest_run');
		runGR.addQuery('u_user', userID);
		runGR.addQuery('u_status', 'IN', 'ready,queued');
		runGR.setLimit(1);
		runGR.query();

		return runGR.next();
	},

	// utility function to count how many unprocessed items still remain linked to a run
	countUnreleasedRunItems: function (runID) {
		var ga = new GlideAggregate('u_daily_digest_item');
		ga.addQuery('u_digest_run', runID);
		ga.addQuery('u_processed', false);
		ga.addAggregate('COUNT');
		ga.query();

		if (ga.next()) {
			var countValue = parseInt(ga.getAggregate('COUNT'), 10);
			if (isNaN(countValue)) {
				return 0;
			} else {
				return countValue;
			}
		}

		return 0;
	},

	// ***************************************
	// ***  UTILITY FUNCTIONS SECTION END  ***
	// ***************************************

	// main function which decides whether a given user should receive a digest now and, if yes, create and queue a run
	// 1) loads or creates the user preferences
	// 2) checks if daily digest is enabled
	// 3) checks if local send time is reached
	// 4) checks if already sent today
	// 5) checks if there is already an active run
	// 6) counts queued items and pending approvals
	// 7) if there is something to send, it creates the run, links items to it, and fires the event
	processUser: function (user, nowTime) {
		// check if the user has a preference row
		var digestPref = this.getOrCreatePref(user);

		// skip users who disabled the daily digest
		if (digestPref.getValue('u_enabled') !== '1') {
			return;
		}

		// get the user's timezone
		var timeZone = this.getUserTimeZoneID(user);

		// get the configured send time
		var sendTime = (this.config.getDefaultSendTime());

		// compute the current local date and local time for the user
		var nowLocal = this.getLocalParts(nowTime, timeZone);

		// if the user's local time is still before the send time do nothing
		if (nowLocal.time < sendTime) {
			return;
		}

		// read the last successful send timestamp from preferences row
		var lastSent = digestPref.getValue('u_last_sent');

		// if there was a prior send prevent sending another digest on the same local calendar day
		if (lastSent) {
			var lastSentGdt = new GlideDateTime(lastSent);
			var lastLocal = this.getLocalParts(lastSentGdt, timeZone);

			if (lastLocal.date === nowLocal.date) {
				return;
			}
		}

		// do not create a new run if the user already has an active "ready" or "queued" run
		if (this.hasOutstandingRun(user.getUniqueValue())) {
			return;
		}

		// declare the lower bound of the digest window
		var since;

		// if the user has received a digest before start from that timestamp
		if (lastSent) {
			since = new GlideDateTime(lastSent);

			// otherwise start from the beginning of the previous local day
		} else {
			since = this.getStartOfPreviousLocalDayUTC(nowTime, timeZone);
		}

		// the upper bound of the digest window is now
		var until = new GlideDateTime(nowTime);

		// count queued digest items in the time window
		var digestSummary = this.getQueuedDigestSummary(user.getUniqueValue(), since, until);

		// count pending approvals in the time window
		var approvalCount = this.countPendingApprovals(user.getUniqueValue());

		// total display count is the sum of both categories
		var totalShownCount = digestSummary.totalShown + approvalCount;

		// if there is literally nothing to show do not create a run
		if (totalShownCount === 0) {
			return;
		}

		// create the new run record
		var runGR = this.createRun(user, since, until, totalShownCount);

		try {
			// claim eligible queue items into the run
			this.linkQueuedItemsToRun(user.getUniqueValue(), since, until, runGR.getUniqueValue());

			// mark the run as queued
			runGR.setValue('u_status', 'queued');
			runGR.setValue('u_error_message', '');
			runGR.update();

			// fire the event that triggers the email notification
			gs.eventQueue('daily_digest.send', runGR);
		} catch (error) {
			// if anything goes wrong after the run was created abort the run and release its items for retry
			this.failRun(runGR, error);
			throw error;
		}
	},

	// function called when a sys_email row get the type = sent, attempting to locate and finalize the digest run
	markRunSentFromEmail: function (emailGR) {
		// if input is not valid do nothing
		if (!emailGR) {
			return;
		}

		// go on only in case of "sent" emails
		var emailType = (emailGR.getValue('type') || '');
		if (emailType !== 'sent') {
			return;
		}

		// extract the embedded run token from the email body or subject
		var runID = this.extractRunIDFromEmail(emailGR);
		if (!runID) {
			return;
		}

		// use sys_updated_on as the sent timestamp or fall back to sys_created_on
		var sentOnValue = emailGR.getValue('sys_updated_on') || emailGR.getValue('sys_created_on');

		// convert the sent timestamp string to GlideDateTime
		var sentOn;
		if (sentOnValue) {
			sentOn = new GlideDateTime(sentOnValue);

			// fall back to now time
		} else {
			sentOn = new GlideDateTime();
		}

		// finalize the run
		this.finalizeRun(runID, sentOn);
	},

	// function to finalize a run after email delivery is successful
	// this marks the run linked items as processed and updates the user's u_last_sent field in the u_daily_digest_preference table
	finalizeRun: function (runOrSysID, sentOn) {
		// convert input into a run sys_id
		var runID = this.getRunID(runOrSysID);
		if (!runID) {
			return;
		}

		// load the current run row through its sys_id
		var freshRun = new GlideRecord('u_daily_digest_run');
		if (!freshRun.get(runID)) {
			return;
		}

		// if the run is already in "sent" or "error" status do nothing
		var persistedStatus = (freshRun.getValue('u_status') || '');
		if (persistedStatus === 'sent' || persistedStatus === 'error') {
			return;
		}

		// use the supplied sent timestamp or fall back to now time
		var now;
		if (sentOn) {
			now = new GlideDateTime(sentOn);
		} else {
			now = new GlideDateTime();
		}

		// mark in bulk all linked and unprocessed items as processed
		var items = new GlideRecord('u_daily_digest_item');
		items.addQuery('u_digest_run', freshRun.getUniqueValue());
		items.addQuery('u_processed', false);
		items.query();
		items.setValue('u_processed', true);
		items.setValue('u_processed_on', now);
		items.updateMultiple();

		// update the user's preference row to record the last successful digest sent time
		var pref = new GlideRecord('u_daily_digest_preference');
		pref.addQuery('u_user', freshRun.getValue('u_user'));
		pref.setLimit(1);
		pref.query();

		if (pref.next()) {
			pref.setValue('u_last_sent', freshRun.getValue('u_until'));
			pref.update();
		}

		// mark the run as "sent"
		freshRun.setValue('u_status', 'sent');
		freshRun.setValue('u_sent_on', now);
		freshRun.setValue('u_error_message', '');
		freshRun.update();
	},

	// function to close a failed run
	// attempt to release unprocessed items attached to a failed run calling releaseRunItems() so that run linked items can be back in the queue
	// if recovery is not successful, set the run status to "error" and log the error message
	failRun: function (runOrSysID, error) {
		// convert input into a run sys_id
		var runID = this.getRunID(runOrSysID);
		if (!runID) {
			return;
		}

		// load the run
		var freshRun = new GlideRecord('u_daily_digest_run');
		if (!freshRun.get(runID)) {
			gs.error('[CustomDailyDigest] Unable to abort the run because it was not found: ' + error);
			return;
		}

		// if the run is already in "sent" or "error" status do nothing
		var persistedStatus = (freshRun.getValue('u_status') || '') + '';
		if (persistedStatus === 'sent' || persistedStatus === 'error') {
			return;
		}

		// attempt to release claimed items back into the queue
		var releaseResult = this.releaseRunItems(freshRun.getUniqueValue());

		// count any items that still remain linked after the release attempt
		var unreleasedCount = this.countUnreleasedRunItems(freshRun.getUniqueValue());

		// get the error text
		var message = (error || '');

		// if recovery was incomplete append diagnostic details
		if (!releaseResult.ok || unreleasedCount > 0) { 
			message += ' | Partial recovery: ' + releaseResult.failed + ' release error(s), ' + unreleasedCount + ' unreleased item(s) remain linked to the run';

			if (releaseResult.failedItemIds.length > 0) {
				message += ' [' + releaseResult.failedItemIds.join(',') + ']';
			}
		}

		// set "error" status and truncated message
		freshRun.setValue('u_status', 'error');
		freshRun.setValue('u_error_message', this.truncate(message, 1000));
		freshRun.update();

		// log errors
		if (!releaseResult.ok || unreleasedCount > 0) {
			gs.error('[CustomDailyDigest] Run failed with partial recovery ' + freshRun.getUniqueValue() + ': ' + message);
		} else {
			gs.error('[CustomDailyDigest] Run failed ' + freshRun.getUniqueValue() + ': ' + error);
		}
	},

	// function to recover runs that have stayed in the "ready" or "queued" state longer than the configured timeout
	recoverStaleQueuedRuns: function (nowTime) {
		// read the system property that stores the timeout
		var timeoutMinutes = this.config.getQueueTimeoutMinutes();

		// compute the cutoff timestamp (now - timeoutMinutes)
		var cutoff = new GlideDateTime(nowTime);
		cutoff.setNumericValue(cutoff.getNumericValue() - (timeoutMinutes * 60 * 1000));

		// query runs still active but older than the cutoff
		var runGR = new GlideRecord('u_daily_digest_run');
		runGR.addQuery('u_status', 'IN', 'ready,queued');
		runGR.addQuery('sys_created_on', '<=', cutoff);
		runGR.query();

		// set to failed each stale run and "release" its items
		while (runGR.next()) {
			this.failRun(runGR, 'Timed out waiting for outbound email to reach type "sent" after ' + timeoutMinutes + ' minutes.');
		}
	},

	// function to merge a "claimed" or "released" item into an existing unclaimed base item
	// useful to restore failed run items back into the queue without creating duplicates or losing data
	// this is especially important for comment aggregates
	mergeReleasedItemIntoBase: function (claimedItemGR, baseItemGR) {
		// get the item type
		var claimedType = (claimedItemGR.getValue('u_type') || '');

		// get and validate the claimed count
		var claimedCount = parseInt(claimedItemGR.getValue('u_count'), 10);
		if (isNaN(claimedCount) || claimedCount < 1) {
			claimedCount = 1;
		}

		// fill missing base display data from claimed item if needed
		if (!baseItemGR.getValue('u_record_number') && claimedItemGR.getValue('u_record_number')) {
			baseItemGR.setValue('u_record_number', claimedItemGR.getValue('u_record_number'));
		}

		if (!baseItemGR.getValue('u_short_description') && claimedItemGR.getValue('u_short_description')) {
			baseItemGR.setValue('u_short_description', claimedItemGR.getValue('u_short_description'));
		}

		if (!baseItemGR.getValue('u_state_display') && claimedItemGR.getValue('u_state_display')) {
			baseItemGR.setValue('u_state_display', claimedItemGR.getValue('u_state_display'));
		}

		// compare occurrence timestamps so we only move the base item forward in time and never backward
		var baseOccurredValue = baseItemGR.getValue('u_occurred_at');
		var claimedOccurredValue = claimedItemGR.getValue('u_occurred_at');
		var shouldTakeClaimedTimestamp = false;

		// if the base has no timestamp take the claimed one if present
		if (!baseOccurredValue) {
			shouldTakeClaimedTimestamp = !!claimedOccurredValue;

			// otherwise compare both timestamps numerically
		} else if (claimedOccurredValue) {
			var baseOccurred = new GlideDateTime(baseOccurredValue);
			var claimedOccurred = new GlideDateTime(claimedOccurredValue);
			shouldTakeClaimedTimestamp = claimedOccurred.getNumericValue() >= baseOccurred.getNumericValue();
		}

		// "comment" type rows require special merge logic because they are counted aggregates
		if (claimedType === 'comment') {
			// add the claimed comment count into the base aggregate
			baseItemGR.addValue('u_count', claimedCount);

			// only replace timestamp, preview and actor fields if the claimed row is newer
			if (shouldTakeClaimedTimestamp) {
				baseItemGR.setValue('u_occurred_at', claimedOccurredValue);
				baseItemGR.setValue('u_last_actor_name', claimedItemGR.getValue('u_last_actor_name') || '');
				baseItemGR.setValue('u_last_comment_preview', claimedItemGR.getValue('u_last_comment_preview') || '');

				if (claimedItemGR.getValue('u_state_display')) {
					baseItemGR.setValue('u_state_display', claimedItemGR.getValue('u_state_display'));
				}
			}

			// "non-comment" type rows just keep the newest timestamp if the claimed one is newer
		} else if (shouldTakeClaimedTimestamp) {
			baseItemGR.setValue('u_occurred_at', claimedOccurredValue);

			if (claimedItemGR.getValue('u_state_display')) {
				baseItemGR.setValue('u_state_display', claimedItemGR.getValue('u_state_display'));
			}
		}

		// update the merged base row
		baseItemGR.update();

		// delete the claimed row now that its data has been merged or restored
		var claimedDelete = new GlideRecord('u_daily_digest_item');
		if (claimedDelete.get(claimedItemGR.getUniqueValue())) {
			claimedDelete.deleteRecord();
		}
	},

	// function to release one claimed item back to the queue
	// takes one digest item currently linked to a failed run and makes it available again for future runs or
	// if a base unclaimed item already exists merge it into that instead, calling mergeReleasedItemIntoBase()
	releaseSingleItem: function (itemGR) {
		// get the item's sys_id
		var itemID = itemGR.getUniqueValue();

		// get the claimed unique key
		var claimedKey = (itemGR.getValue('u_unique_key') || '');

		// compute the original base key by removing the claim suffix
		var baseKey = this.stripClaimSuffix(claimedKey);

		// look for an already unclaimed sibling row with the same base key
		var sibling = new GlideRecord('u_daily_digest_item');
		sibling.addQuery('u_unique_key', baseKey);
		sibling.addNullQuery('u_digest_run');
		sibling.addQuery('u_processed', false);
		sibling.addQuery('sys_id', '!=', itemID);
		sibling.setLimit(1);
		sibling.query();

		// if found merge this released row into that sibling and stop
		if (sibling.next()) {
			this.mergeReleasedItemIntoBase(itemGR, sibling);
			return;
		}

		// otherwise restore this row itself back to the base key and clear its "claim"/"run" markers
		itemGR.setValue('u_unique_key', baseKey);
		itemGR.setValue('u_digest_run', 'NULL');
		itemGR.setValue('u_processed', false);
		itemGR.setValue('u_processed_on', 'NULL');

		try {
			// save the released row
			itemGR.update();
		} catch (error) {
			// if a duplicate happened while releasing re-query the base row and merge instead
			if (this.isDuplicateKeyError(error)) {
				var retryBase = new GlideRecord('u_daily_digest_item');
				retryBase.addQuery('u_unique_key', baseKey);
				retryBase.addNullQuery('u_digest_run');
				retryBase.addQuery('u_processed', false);
				retryBase.addQuery('sys_id', '!=', itemID);
				retryBase.setLimit(1);
				retryBase.query();

				if (retryBase.next()) {
					var freshClaimed = new GlideRecord('u_daily_digest_item');
					if (freshClaimed.get(itemID)) {
						this.mergeReleasedItemIntoBase(freshClaimed, retryBase);
						return;
					}
				}
			}

			// rethrow unexpected failures
			throw error;
		}
	},

	// function to attempt to release every unprocessed item linked to a failed run
	// basically does the same thing as releaseSingleItem() but for all unprocessed items of one failed run
	releaseRunItems: function (runID) {
		// start a result object for diagnostics
		var result = {
			ok: true,
			released: 0,
			failed: 0,
			failedItemIds: []
		};

		// query all unprocessed items linked to the run
		var item = new GlideRecord('u_daily_digest_item');
		item.addQuery('u_digest_run', runID);
		item.addQuery('u_processed', false);
		item.orderBy('sys_created_on');
		item.query();

		// release each one individually so partial failure is possible and diagnosable
		while (item.next()) {
			var itemID = item.getUniqueValue();

			try {
				this.releaseSingleItem(item);
				result.released++;
			} catch (error) {
				result.ok = false;
				result.failed++;
				result.failedItemIds.push(itemID);
				gs.error('[CustomDailyDigest] Failed to release digest item ' + itemID + ' for run ' + runID + ': ' + error);
			}
		}

		return result;
	},

	// main function which runs the daily digest
	// recover stale runs first calling recoverStaleQueuedRuns() 
	// then process all candidate users calling processUser() for each one
	digestRun: function () {
		// get now time
		var nowTime = new GlideDateTime();

		// recover runs that have been stuck for too long
		this.recoverStaleQueuedRuns(nowTime);

		// find all users who might have pending daily digest items
		var candidateUserIDs = this.getCandidateUsers();

		// do nothing if there are no daily digest candidate users
		if (candidateUserIDs.length === 0) {
			return;
		}

		// query active users with an email address from the candidate list
		var userGR = new GlideRecord('sys_user');
		userGR.addQuery('sys_id', 'IN', candidateUserIDs.join(','));
		userGR.addQuery('active', true);
		userGR.addQuery('email', '!=', '');
		userGR.query();

		// process each candidate user
		while (userGR.next()) {
			try {
				this.processUser(userGR, nowTime);
			} catch (error) {
				gs.error('[CustomDailyDigest] Error processing user ' + userGR.getUniqueValue() + ': ' + error);
			}
		}
	},

	type: 'DailyDigestScheduler'
};