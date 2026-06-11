// script include responsible for capturing custom daily digest activities and inserting rows into u_daily_digest_item table
var DailyDigestQueue = Class.create();

DailyDigestQueue.prototype = {
	initialize: function () {
		// load the config helper to read properties
		this.config = new DailyDigestConfig();

		// read the configured daily digest source tables and journal element types
		this.sourceTables = this.config.getSourceTables();
		this.journalElementTypes = this.config.getJournalElementTypes();

		// initialize cache of username -> user sys_id
		// used when excluding the comment author from recipients
		// example: userNameToSysIDCache[user_name] = sys_id (32 chars string)
		this.userNameToSysIDCache = {};

		// initialize cache of user sys_id -> digest enabled boolean
		// used to avoid repeated queries to u_daily_digest_preference table in the same execution
		// example: userDigestEnabledCache[sys_id] = boolean (true or false)
		this.userDigestEnabledCache = {};

		// initialize cache of user sys_id -> time zone string
		// used so we do not repeatedly query sys_user for the same recipient
		// example: userTimeZoneCache[sys_id] = UTC / Whatever (40 chars string)
		this.userTimeZoneCache = {};
	},

	// ***************************************
	// *** UTILITY FUNCTIONS SECTION START ***
	// ***************************************

	// utility function to find if an element is contained in an array
	isInArray: function (array, element) {
		// null or undefined array return false
		if (!array) {
			return false;
		}

		// loop over the array and check equality for the element, return true if found
		for (var i = 0; i < array.length; i++) {
			if (array[i] === element) {
				return true;
			}
		}

		// return false if no match is found
		return false;
	},

	// utility function to check if the passed table belongs to one of the configured daily digest source tables
	isSourceTable: function (sourceTableGR) {
		// if no records are found return false
		if (!sourceTableGR) {
			return false;
		}

		// compare the current record table name to the configured source table list
		// return true if found, else false
		return this.isInArray(this.sourceTables, sourceTableGR.getTableName());
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

	// utility function to retrieve sys_user.sys_id from sys_user.user_name
	// used mainly for excluding the author of a comment from digest recipients
	getUserSysIDByUserName: function (userName) {
		// convert input to a string
		userName = (userName || '') + '';

		// empty user_name return empty sys_id
		if (!userName) {
			return '';
		}

		// return the cached answer if we already looked this username up earlier in this run
		if (this.userNameToSysIDCache.hasOwnProperty(userName)) {
			return this.userNameToSysIDCache[userName];
		}

		// initialize default empty sys_id
		var userId = '';

		// query sys_user by user_name
		var userGR = new GlideRecord('sys_user');
		userGR.addQuery('user_name', userName);
		userGR.setLimit(1);
		userGR.query();

		// if found capture the sys_id
		if (userGR.next()) {
			userId = userGR.getUniqueValue();
		}

		// cache the result so we do not repeat the same lookup again in the future
		this.userNameToSysIDCache[userName] = userId;

		// return the found sys_id
		return userId;
	},

	// utility function to determine whether daily digest is enabled for a specific user
	isDigestEnabledForUser: function (userSysID) {
		// convert input to string
		userSysID = (userSysID || '') + '';

		// return false for empty sys_id
		if (!userSysID) {
			return false;
		}

		// use the cached value if available to avoid querying table again
		if (this.userDigestEnabledCache.hasOwnProperty(userSysID)) {
			return this.userDigestEnabledCache[userSysID];
		}

		// set default daily digest preference as disabled
		var enabled = false;

		// query the preference row for the user
		var prefGR = new GlideRecord('u_daily_digest_preference');
		prefGR.addQuery('u_user', userSysID);
		prefGR.setLimit(1);
		prefGR.query();

		// retrieve the stored daily digest enabled preference value converting it from a string to a boolean
		// if the stored value is empty the default daily digest enabled preference is set to false
		if (prefGR.next()) {
			enabled = (prefGR.getValue('u_enabled') || '0') === '1';
		}

		// cache the daily digest enabled preference
		this.userDigestEnabledCache[userSysID] = enabled;

		// return the daily digest enabled preference as a boolean
		return enabled;
	},

	// utility function to retrieve sys_user.time_zone
	getUserTimeZoneBySysID: function (userSysID) {
		// return UTC for empty sys_id
		if (!userSysID) {
			return 'UTC';
		}

		// return cached timezone if available to avoid querying table again
		if (this.userTimeZoneCache[userSysID]) {
			return this.userTimeZoneCache[userSysID];
		}

		// set default timezone to UTC
		var timeZone = 'UTC';

		// query the time_zone field for the user
		var userGR = new GlideRecord('sys_user');
		if (userGR.get(userSysID)) {
			// get and trim the time_zone value
			timeZone = (userGR.getValue('time_zone') || '');
			timeZone = timeZone.trim();

			// fallback to UTC if timezone is blank
			if (!timeZone) {
				timeZone = 'UTC';
			}
		}

		// cache the timezone value
		this.userTimeZoneCache[userSysID] = timeZone;

		// return the timezone value
		return timeZone;
	},

	// utility function to format a GlideDateTime in a specific timezone using a given java date pattern
	// used to compute the recipient local "day-key"
	// needed for correct aggregation of comments and dedupe of items by user's own timezone and not by server's timezone
	// might not work as expected in future because java package calls could be prevented
	formatDateInTimeZone: function (gdt, timeZone) {
		// build a java timezone object from the timezone value
		var tz = Packages.java.util.TimeZone.getTimeZone(timeZone);

		// build a java date formatter with a date only pattern
		var sdf = new Packages.java.text.SimpleDateFormat('yyyy-MM-dd');

		// apply the timezone to the formatter
		sdf.setTimeZone(tz);

		// convert the GlideDateTime into a java date format
		var javaDate = new Packages.java.util.Date(gdt.getNumericValue());

		// convert and return the date as string (yyyy-MM-dd)
		return '' + sdf.format(javaDate);
	},

	// utility function to compute the recipient local "day-key" for a given occurred time
	getDayKeyForRecipient: function (occurred, recipientUserSysID) {
		// get recipient timezone
		var timeZone = this.getUserTimeZoneBySysID(recipientUserSysID);

		// convert the given occurred time into a recipient local yyyy-MM-dd date string
		return this.formatDateInTimeZone(occurred, timeZone);
	},

	// utility function to remove pending "assigned" type rows for records that no longer match the current assignee in u_daily_digest_item
	// needed when a case is reassigned, this removes old pending "assigned" rows that no longer reflect reality
	removeStaleAssignedItems: function (sourceTableGR) {
		// go on only in case of valid table or assignee
		if (!sourceTableGR || !sourceTableGR.isValidField('assigned_to')) {
			return;
		}

		// fetch the needed info from the input
		var tableName = sourceTableGR.getTableName();
		var recordSysID = sourceTableGR.getUniqueValue();
		var currentAssignee = sourceTableGR.getValue('assigned_to') || '';

		// find the corresponding pending assigned items, which are still unprocessed and unattached to any run
		var stale = new GlideRecord('u_daily_digest_item');
		stale.addQuery('u_type', 'assigned');
		stale.addQuery('u_table', tableName);
		stale.addQuery('u_record_sys_id', recordSysID);
		stale.addQuery('u_processed', false);
		stale.addNullQuery('u_digest_run');

		// if there is a valid current assignee, remove rows assigned to everyone else
		// if the current assignee was cleared, clear all pending assigned rows
		if (currentAssignee) {
			stale.addQuery('u_recipient', '!=', currentAssignee);
		}

		stale.query();
		while (stale.next()) {
			stale.deleteRecord();
		}
	},

	// utility function to detect whether a case has reached a "closed" or "resolved" state
	isCloseLikeTransition: function (sourceTableGR) {
		if (!sourceTableGR) {
			return false;
		}

		// if the case is inactive treat it as closed
		if (sourceTableGR.isValidField('active') && sourceTableGR.active.changesTo(false)) {
			return true;
		}

		// act if state changes to "closed" or "resolved" even if active stays true
		if (sourceTableGR.isValidField('state') && sourceTableGR.state.changes()) {
			var stateDisplay = (sourceTableGR.getDisplayValue('state') || '').toLowerCase().trim();
			if (stateDisplay === 'resolved' || stateDisplay.indexOf('closed') === 0) {
				return true;
			}
		}

		return false;
	},

	// ***************************************
	// ***  UTILITY FUNCTIONS SECTION END  ***
	// ***************************************

	// function to insert a single (non-comment type) digest item into the u_daily_digest_item table
	// to prevent duplicate rows a deduplication logic based on a u_unique_key is implemented
	// items are deduped by: recipient + record type + source table + record sys_id + recipient local day
	queueItem: function (recipientUserSysID, recordType, sourceTableGR, occurred) {
		// do nothing in case of invalid recipient
		if (!recipientUserSysID) {
			return;
		}

		// do nothing in case user has the daily digest disabled
		if (!this.isDigestEnabledForUser(recipientUserSysID)) {
			return;
		}

		// get the item's source table name
		var tableName = sourceTableGR.getTableName();

		// get the item's source record sys_id
		var recordSysID = sourceTableGR.getUniqueValue();

		// compute the recipient local "day-key" for the server occurred item timestamp
		// this is what makes daily dedupe based on user's timezone possible
		var dayKey = this.getDayKeyForRecipient(occurred, recipientUserSysID);

		// compute the item's unique dedupe key
		// example: userSysID|opened|incident|recordSysId|2026-03-10
		var uniqueKey = [recipientUserSysID, recordType, tableName, recordSysID, dayKey].join('|');

		// initialize a new digest item row
		var item = new GlideRecord('u_daily_digest_item');
		item.initialize();

		// store the item's unique dedupe key
		item.setValue('u_unique_key', uniqueKey);

		// store who should receive the digest entry
		item.setValue('u_recipient', recipientUserSysID);

		// store the item case type (opened, assigned or closed)
		item.setValue('u_type', recordType);

		// store the item's source table name
		item.setValue('u_table', tableName);

		// store the sys_id of the item's source record
		item.setValue('u_record_sys_id', recordSysID);

		// store the item's record number 
		// example: INC0009009, PRB0007601, etc...
		item.setValue('u_record_number', sourceTableGR.getValue('number'));

		// store the item's short description
		item.setValue('u_short_description', sourceTableGR.getValue('short_description'));

		// store when this item's event occurred
		item.setValue('u_occurred_at', occurred);

		// mark the digest item as not yet processed
		item.setValue('u_processed', false);

		// if the item's source table has a state field store its display value for later email rendering
		if (sourceTableGR.isValidField('state')) {
			item.setValue('u_state_display', sourceTableGR.getDisplayValue('state'));
		} else {
			// otherwise store it blank
			item.setValue('u_state_display', '');
		}

		try {
			// attempt inserting the item into u_daily_digest_item
			item.insert();
		} catch (error) {
			// in case of u_unique_key collision try to log it
			if (this.isDuplicateKeyError(error)) {
				gs.debug('[CustomDailyDigest] Duplicate daily digest item ignored for ' + uniqueKey);
				return;
			}

			// log also any other error it might happen during item queueing
			gs.error('[CustomDailyDigest] queueItem failed for ' + uniqueKey + ': ' + error);
		}
	},

	// function to insert or update an aggregated comment digest item into the u_daily_digest_item table
	// to avoid creating new rows for every new comment on the same case a similar logic to queueItem based on u_unique_key is applied here to aggregate comments
	// in addition u_count acts as a counter and it is incremented for each additional comment
	// comments are grouped by: recipient + record type (comment) + source table + record sys_id + recipient local day
	queueCommentAggregated: function (recipientUserSysID, targetTableGR, occurred, extra) {
		// do nothing in case of invalid recipient
		if (!recipientUserSysID) {
			return;
		}

		// do nothing in case user has the daily digest disabled
		if (!this.isDigestEnabledForUser(recipientUserSysID)) {
			return;
		}

		// initialize extra as an empty object
		// needed for additional comment metadata that are not part of the base item record like in queueItem
		// example: u_last_actor_name (who made the last comment), u_last_comment_preview (short preview of the comment text)
		if (!extra) {
			extra = {};
		}

		// get comment's source table name
		var tableName = targetTableGR.getTableName();

		// get comment's record sys_id
		var recordSysID = targetTableGR.getUniqueValue();

		// compute the recipient local "day-key" for the server occurred comment timestamp
		// this is what makes daily aggregation based on user's timezone possible
		var dayKey = this.getDayKeyForRecipient(occurred, recipientUserSysID);

		// compute the comment's aggregation unique key
		// example: userSysID|comment|incident|recordSysId|2026-03-10
		var uniqueKey = [recipientUserSysID, 'comment', tableName, recordSysID, dayKey].join('|');

		// before creating a new row first try to find an existing unclaimed or unprocessed aggregate row for the same key
		var existing = new GlideRecord('u_daily_digest_item');
		existing.addQuery('u_unique_key', uniqueKey);
		existing.addNullQuery('u_digest_run');
		existing.addQuery('u_processed', false);
		existing.query();

		// if such a row exists update it in place instead of inserting a new row
		if (existing.next()) {
			// increment the comment count
			existing.addValue('u_count', 1);

			// store the latest known actor name
			existing.setValue('u_last_actor_name', extra.actor || '');

			// store a truncated preview of the latest comment
			existing.setValue('u_last_comment_preview', this.truncate(extra.preview || '', 255));

			// update the occurrence timestamp to the latest comment time for this aggregate row
			existing.setValue('u_occurred_at', occurred);

			// update state display value if available
			if (targetTableGR.isValidField('state')) {
				existing.setValue('u_state_display', targetTableGR.getDisplayValue('state'));
			}

			// save the updated aggregate row
			existing.update();
			return;
		}

		// if no existing row was found with the same unique key create a new aggregate row in u_daily_digest_item
		var item = new GlideRecord('u_daily_digest_item');
		item.initialize();

		// store the comment's unique key used for aggregation
		item.setValue('u_unique_key', uniqueKey);

		// store the comment's recipient
		item.setValue('u_recipient', recipientUserSysID);

		// store the type of record (comment)
		item.setValue('u_type', 'comment');

		// store the comment's source table name
		item.setValue('u_table', tableName);

		// store the sys_id of the comment's source record
		item.setValue('u_record_sys_id', recordSysID);

		// store the comment related item's record number 
		// example: INC0009009, PRB0007601, etc...
		item.setValue('u_record_number', targetTableGR.getValue('number'));

		// store the comment related item's short description
		item.setValue('u_short_description', targetTableGR.getValue('short_description'));

		// store the comment's occurred time
		item.setValue('u_occurred_at', occurred);

		// mark the digest comment item as not yet processed
		item.setValue('u_processed', false);

		// given that this is the first comment of the aggregate row the u_count starts at 1
		item.setValue('u_count', 1);

		// store the last actor name (who was the last to comment)
		item.setValue('u_last_actor_name', extra.actor || '');

		// store a truncated preview of the last comment
		item.setValue('u_last_comment_preview', this.truncate(extra.preview || '', 255));

		// store the comment related item's state display if present
		if (targetTableGR.isValidField('state')) {
			item.setValue('u_state_display', targetTableGR.getDisplayValue('state'));
		} else {
			// otherwise store it blank
			item.setValue('u_state_display', '');
		}

		try {
			// attempt to insert the new comment aggregate row
			item.insert();
		} catch (error) {
			// if another process inserted the same aggregate simultaneously query again and update that row instead
			// needed for handling race condition (when more comments are added in a short timespan)
			if (this.isDuplicateKeyError(error)) {
				var retry = new GlideRecord('u_daily_digest_item');
				retry.addQuery('u_unique_key', uniqueKey);
				retry.addNullQuery('u_digest_run');
				retry.addQuery('u_processed', false);
				retry.query();

				if (retry.next()) {
					retry.addValue('u_count', 1);
					retry.setValue('u_last_actor_name', extra.actor || '');
					retry.setValue('u_last_comment_preview', this.truncate(extra.preview || '', 255));
					retry.setValue('u_occurred_at', occurred);

					if (targetTableGR.isValidField('state')) {
						retry.setValue('u_state_display', targetTableGR.getDisplayValue('state'));
					}

					retry.update();
					return;
				}
			}

			// log also any other error it might happen during comment queueing
			gs.error('[CustomDailyDigest] queueCommentAggregated failed for ' + uniqueKey + ': ' + error);
		}
	},

	// function to queue "opened" type activities into the u_daily_digest_item table
	// also queues "assigned" type at open time if the record already has an assignee
	queueCaseOpened: function (sourceTableGR) {
		// ignore source tables that are not configured in the system properties
		if (!this.isSourceTable(sourceTableGR)) {
			return;
		}

		// use the record creation timestamp as the event time
		var occurred = new GlideDateTime(sourceTableGR.getValue('sys_created_on'));

		// if the table has an opened_by valid field queue an "opened" type item for that user
		if (sourceTableGR.isValidField('opened_by')) {
			var openedBy = sourceTableGR.getValue('opened_by');
			if (openedBy) {
				this.queueItem(openedBy, 'opened', sourceTableGR, occurred);
			}
		}

		// if the record was already assigned at insert time queue an "assigned" type item too
		if (sourceTableGR.isValidField('assigned_to')) {
			var assignedTo = sourceTableGR.getValue('assigned_to');
			if (assignedTo) {
				this.queueItem(assignedTo, 'assigned', sourceTableGR, occurred);
			}
		}
	},

	// function to queue "assigned" type activities into the u_daily_digest_item table when assigned_to changes on update
	queueCaseAssigned: function (sourceTableGR) {
		// ignore source tables that are not configured in the system properties
		if (!this.isSourceTable(sourceTableGR)) {
			return;
		}

		// do nothing if the table has no valid assigned_to field
		if (!sourceTableGR.isValidField('assigned_to')) {
			return;
		}

		// only react when assigned_to actually changes (.changes() will work properly only with synchronous business rule)
		if (!sourceTableGR.assigned_to.changes()) {
			return;
		}

		// remove stale pending assigned items for previous assignees
		this.removeStaleAssignedItems(sourceTableGR);

		// ignore changes that clear the field, only queue when there is a new valid assignee (.nil() will work properly only with synchronous business rule)
		if (sourceTableGR.assigned_to.nil()) {
			return;
		}

		// use "now" as the assignment event timestamp
		var occurred = new GlideDateTime();

		// get the new assignee sys_id as a string
		var newAssignee = sourceTableGR.assigned_to.toString();

		// queue the assignment type item
		this.queueItem(newAssignee, 'assigned', sourceTableGR, occurred);
	},

	// function to queue "closed" type activities into the u_daily_digest_item table when the record becomes inactive
	queueCaseClosed: function (sourceTableGR) {
		// ignore source tables that are not configured in the system properties
		if (!this.isSourceTable(sourceTableGR)) {
			return;
		}

		// act only on a close-like state
		if (!this.isCloseLikeTransition(sourceTableGR)) {
			return;
		}

		// use "now" as the close event timestamp
		var occurred = new GlideDateTime();

		// build a recipient set using an object so duplicates collapse automatically
		var recipients = {};

		// opened-by user should get the close digest if present
		if (sourceTableGR.isValidField('opened_by')) {
			var openedBy = sourceTableGR.getValue('opened_by');
			if (openedBy) {
				recipients[openedBy] = true;
			}
		}

		// assigned-to user should also get the close digest if present
		if (sourceTableGR.isValidField('assigned_to')) {
			var assignedTo = sourceTableGR.getValue('assigned_to');
			if (assignedTo) {
				recipients[assignedTo] = true;
			}
		}

		// queue the closed item type per unique recipient
		for (var userId in recipients) {
			this.queueItem(userId, 'closed', sourceTableGR, occurred);
		}
	},

	// function to queue "comment" type activities into the u_daily_digest_item table when a new journal entry is inserted into sys_journal_field
	queueJournalElement: function (journalTable) {
		// get the name of the source table that the journal element belongs to
		var tableName = journalTable.getValue('name');

		// get the journal field name (for example: "comments" or "work_notes")
		var element = journalTable.getValue('element');

		// ignore journal elements that are not configured for digesting in the system properties
		if (!this.isInArray(this.journalElementTypes, element)) {
			return;
		}

		// ignore journal rows from source tables that are not configured in the system properties
		if (!this.isInArray(this.sourceTables, tableName)) {
			return;
		}

		// get the sys_id of the source record referenced by the journal entry
		var targetSysID = journalTable.getValue('element_id');

		// load that source record if present
		var target = new GlideRecord(tableName);
		if (!target.get(targetSysID)) {
			return;
		}

		// build a recipient set using an object so duplicates collapse automatically
		var recipients = {};

		// consider opened_by as a potential recipient
		if (target.isValidField('opened_by')) {
			var openedBy = target.getValue('opened_by');
			if (openedBy) {
				recipients[openedBy] = true;
			}
		}

		// consider assigned_to as a potential recipient
		if (target.isValidField('assigned_to')) {
			var assignedTo = target.getValue('assigned_to');
			if (assignedTo) {
				recipients[assignedTo] = true;
			}
		}

		// consider caller_id as a potential recipient (useful especially for incident)
		if (target.isValidField('caller_id')) {
			var callerId = target.getValue('caller_id');
			if (callerId) {
				recipients[callerId] = true;
			}
		}

		// consider requested_for as a potential recipient (useful especially for request items)
		if (target.isValidField('requested_for')) {
			var requestedFor = target.getValue('requested_for');
			if (requestedFor) {
				recipients[requestedFor] = true;
			}
		}

		// get sys_created_by on sys_journal_field which contains the username of the comment author
		var authorUserName = journalTable.getValue('sys_created_by');

		// convert that username to a sys_user.sys_id so we can exclude the author from the recipient set
		var authorSysID = this.getUserSysIDByUserName(authorUserName);

		// if the author was resolved to a user remove them from the recipient set so they do not get notified for their own comments
		if (authorSysID) {
			delete recipients[authorSysID];
		}

		// set the journal row creation timestamp as the comment occurrence time
		var occurred = new GlideDateTime(journalTable.getValue('sys_created_on'));

		// get the raw comment text for preview storage
		var preview = journalTable.getValue('value');

		// queue or aggregate a comment item for each remaining recipient
		for (var userID in recipients) {
			this.queueCommentAggregated(userID, target, occurred, {
				actor: authorUserName,
				preview: preview
			});
		}
	},

	type: 'DailyDigestQueue'
};