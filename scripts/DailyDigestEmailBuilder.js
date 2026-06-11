// script include responsible for building the daily digest email from a u_daily_digest_run record and its linked items
var DailyDigestEmailBuilder = Class.create();

DailyDigestEmailBuilder.prototype = {
	initialize: function () {
		// load the config helper to read properties
		this.config = new DailyDigestConfig();

		// get the base instance URL used for record links in the email
		this.baseURL = this.config.getBaseURL();

		// set the max number of items to show per mail section
		this.maxPerSection = 10;
	},

	// ***************************************
	// *** UTILITY FUNCTIONS SECTION START ***
	// ***************************************

	// utility function to replace any HTML special or unsafe characters with their HTML escape codes
	// so text is safe to display protecting the email from HTML injections
	sanitizeIllegalChars: function (s) {
		return GlideStringUtil.escapeHTML((s || ''));
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

	// utility function to convert a u_daily_digest_item record into a lightweight object so that the HTML renderer can use it easily
	renderItemModel: function (itemGR) {
		// read source table and source record id
		var table = itemGR.getValue('u_table');
		var sysID = itemGR.getValue('u_record_sys_id');

		// read record display values (or the safe fallbacks)
		var number = itemGR.getValue('u_record_number') || '(record)';
		var shortDesc = itemGR.getValue('u_short_description') || '';
		var state = itemGR.getValue('u_state_display') || '';

		// build the classic nav_to.do URL for the source record
		var uri = table + '.do?sys_id=' + sysID;
		var url = this.baseURL + '/nav_to.do?uri=' + encodeURIComponent(uri);

		// read and validate the count field
		var count = parseInt(itemGR.getValue('u_count'), 10);
		if (isNaN(count) || count < 1) {
			count = 1;
		}

		// return a plain object used later by sectionHTML()
		return {
			number: number,
			shortDesc: shortDesc,
			state: state,
			url: url,
			count: count,
			lastActor: itemGR.getValue('u_last_actor_name') || '',
			lastPreview: itemGR.getValue('u_last_comment_preview') || ''
		};
	},

	// utility function to adds together the count property values of all items in an array
	// mainly used for calculating the total number of comments represented by aggregated comment rows
	sumItemCounts: function (items) {
		var total = 0;
		for (var i = 0; i < items.length; i++) {
			total += parseInt(items[i].count, 10) || 0;
		}

		return total;
	},

	// utility function to build list URLs when the maxPerSection cap is surpassed
	buildListURL: function (tableName, query) {
		var uri = tableName + '_list.do?sysparm_query=' + query;
		return this.baseURL + '/nav_to.do?uri=' + encodeURIComponent(uri);
	},

	// ***************************************
	// ***  UTILITY FUNCTIONS SECTION END  ***
	// ***************************************

	// function responsible to build a single daily digest section as an HTML table
	// take the list of daily digest items and print rows with record link, summary, state, etc.
	// if isCommentSection is true include also the "new comments" column
	sectionHTML: function (title, items, isCommentSection, moreURL) {
		// no items means nothing to render
		if (!items || items.length === 0) {
			return '';
		}

		// start of the section container
		var html = '';
		html += '<h3 style="margin:18px 0 8px 0">' + this.sanitizeIllegalChars(title) + '</h3>';
		html += '<table cellpadding="6" cellspacing="0" style="width:100%;border-collapse:collapse;border:1px solid #e6e6e6">';
		html += '<tr style="background:#f7f7f7">';
		html += '<th align="left" style="border-bottom:1px solid #e6e6e6">Record</th>';
		html += '<th align="left" style="border-bottom:1px solid #e6e6e6">Summary</th>';
		html += '<th align="left" style="border-bottom:1px solid #e6e6e6">State</th>';

		// add the "new comments" column if needed
		if (isCommentSection) {
			html += '<th align="left" style="border-bottom:1px solid #e6e6e6">New comments</th>';
		}

		html += '</tr>';

		// set rows limit
		var limit = Math.min(items.length, this.maxPerSection);

		// render one row per item
		for (var i = 0; i < limit; i++) {
			var it = items[i];

			html += '<tr>';

			// record number column with hyperlink
			html += '<td style="border-bottom:1px solid #f0f0f0">';
			html += '<a href="' + it.url + '">';
			html += this.sanitizeIllegalChars(it.number);
			html += '</a>';
			html += '</td>';

			// summary column
			html += '<td style="border-bottom:1px solid #f0f0f0">';
			html += this.sanitizeIllegalChars(it.shortDesc);
			html += '</td>';

			// state column
			html += '<td style="border-bottom:1px solid #f0f0f0">';
			html += this.sanitizeIllegalChars(it.state);
			html += '</td>';

			// comment specific details column
			if (isCommentSection) {
				// first line starts with the comment count
				var firstLineText = '' + it.count;

				// if we know the last actor show that too
				if (it.lastActor) {
					firstLineText += ' (last by ' + it.lastActor + ')';
				}

				// sanitize the first line of text
				var commentCellHtml = this.sanitizeIllegalChars(firstLineText);

				// if we have a preview render it below in smaller text
				if (it.lastPreview) {
					commentCellHtml += '<br/><span style="color:#666;font-size:12px">';
					commentCellHtml += this.sanitizeIllegalChars(it.lastPreview);
					commentCellHtml += '</span>';
				}

				// output the final comment cell
				html += '<td style="border-bottom:1px solid #f0f0f0">';
				html += commentCellHtml;
				html += '</td>';
			}

			html += '</tr>';
		}

		// close the table
		html += '</table>';

		// add the "show more" link if we are above the item limit
		if (items.length > limit && moreURL) {
			html += '<div style="margin-top:6px;font-size:12px">';
			html += '<a href="' + moreURL + '">Show ' + (items.length - limit) + ' more...</a>';
			html += '</div>';
		}

		// return the HTML section
		return html;
	},

	// function responsible to build the "approvals" part HTML section of the daily digest
	// take the pending approvals and render them as a linked bullet list
	approvalSectionHTML: function (approvals, approvalTotal, moreURL) {
		// no pending approvals means nothing to render
		if (!approvals || approvals.length === 0) {
			return '';
		}

		// approval section start
		var html = '';
		html += '<h3 style="margin:18px 0 8px 0">Pending approvals</h3>';

		// approval list start
		html += '<ul style="margin:0;padding-left:18px">';

		// render each approval as a linked list item
		for (var i = 0; i < approvals.length; i++) {
			var a = approvals[i];
			html += '<li>';
			html += '<a href="' + a.url + '">';
			html += this.sanitizeIllegalChars(a.label);
			html += '</a>';
			html += '</li>';
		}

		// close approval list and return the HTML approval section
		html += '</ul>';

		// if not all approvals are shown add a "show more" link
		if (approvalTotal > approvals.length && moreURL) {
			html += '<div style="color:#666;font-size:12px;margin-bottom:6px">';
			html += '<a href="' + moreURL + '">Show ' + (approvalTotal - approvals.length) + ' more...</a>';
			html += '</div>';
		}

		return html;
	},

	// function responsible to query and summarize the user's currently pending approvals from sysapproval_approver
	// return an object with the total number of pending approvals and a list of them with labels and hyperlinks
	// needed because pending approvals are not stored in u_daily_digest_item and are not captured any Business Rules
	getPendingApprovalsSummary: function (userID) {
		// initialize result object
		var out = {
			total: 0,
			rows: []
		};

		// count all pending approvals for the user
		var ga = new GlideAggregate('sysapproval_approver');
		ga.addQuery('approver', userID);
		ga.addQuery('state', 'requested');
		ga.addAggregate('COUNT');
		ga.query();

		if (ga.next()) {
			out.total = parseInt(ga.getAggregate('COUNT'), 10) || 0;
		}

		// query the most recent approvals
		var gr = new GlideRecord('sysapproval_approver');
		gr.addQuery('approver', userID);
		gr.addQuery('state', 'requested');
		gr.orderByDesc('sys_created_on');
		gr.setLimit(this.maxPerSection);
		gr.query();

		while (gr.next()) {
			// use the approval target's display value as the label
			var label = gr.getDisplayValue('sysapproval') || 'Approval';

			// build a direct link to the approval record
			var approvalUri = 'sysapproval_approver.do?sys_id=' + gr.getUniqueValue();
			var url = this.baseURL + '/nav_to.do?uri=' + encodeURIComponent(approvalUri);

			// push the row to the object
			out.rows.push({
				label: label,
				url: url
			});
		}

		// return pending approvals total count and list with labels and links
		return out;
	},

	// main function responsible to take one digest run and generate the final email content for it
	// 1) loads the target user from the run
	// 2) loads all u_daily_digest_item rows linked to that run
	// 3) groups the rows into sections (opened, assigned, comment, closed)
	// 4) loads the pending approvals separately
	// 5) calculates the total count for every case type section
	// 6) builds the email subject and the full HTML body returning an object like:
	// {
	//   subject: 'Your daily digest - 2026-03-10',
	//   html: '<div>...</div>'
	// }
	buildMail: function (run) {
		// read the target user's sys_id from the run
		var userID = run.getValue('u_user');

		// load the user so we can use their display name and timezone values
		var user = new GlideRecord('sys_user');
		if (!user.get(userID)) {
			// if the user cannot be found return a fallback message.
			return {
				subject: 'Daily summary',
				html: 'User not found.'
			};
		}

		// get the run's upper bound timestamp
		var until = new GlideDateTime(run.getValue('u_until'));

		// get the user's timezone
		var tzId = this.getUserTimeZoneID(user);

		// format the digest date in the user's timezone
		var digestDate = this.formatDateInTimeZone(until, tzId);

		// capture the run sys_id so it can be embedded into the outgoing email
		// that token is later used to correlate sys_email back to this run to confirm successful send
		var runToken = run.getUniqueValue();

		// "show more" links builder
		// ACLs are used to manage permissions of u_daily_digest_item -> a user can only read their own rows
		var moreURLs = {
			opened: this.buildListURL('u_daily_digest_item', 'u_digest_run=' + runToken + '^u_type=opened'),
			assigned: this.buildListURL('u_daily_digest_item', 'u_digest_run=' + runToken + '^u_type=assigned'),
			comment: this.buildListURL('u_daily_digest_item', 'u_digest_run=' + runToken + '^u_type=comment'),
			closed: this.buildListURL('u_daily_digest_item', 'u_digest_run=' + runToken + '^u_type=closed'),
			approval: this.buildListURL('sysapproval_approver', 'approver=' + userID + '^state=requested')
		};

		// initialize arrays for the different daily digest sections
		var sections = {
			opened: [],
			assigned: [],
			comment: [],
			closed: [],
			approval: []
		};

		// query all daily digest items linked to the run
		var runID = (run.getUniqueValue() || '') + '';
		var items = new GlideRecord('u_daily_digest_item');
		items.addQuery('u_digest_run', runID);
		items.orderBy('u_type');
		items.orderByDesc('u_occurred_at');
		items.query();

		// convert each row into a lightweight render model and place it in the right section
		while (items.next()) {
			var rawType = ((items.getValue('u_type') || '') + '').toLowerCase().trim();
			var displayType = ((items.getDisplayValue('u_type') || '') + '').toLowerCase().trim();
			var t = rawType || displayType;

			var model = this.renderItemModel(items);

			switch (t) {
				case 'opened':
					sections.opened.push(model);
					break;

				case 'assigned':
					sections.assigned.push(model);
					break;

				case 'comment':
					sections.comment.push(model);
					break;

				case 'closed':
					sections.closed.push(model);
					break;

				default:
					gs.info('[CustomDailyDigest] buildMail ignored item ' + items.getUniqueValue() + ' for run ' + runID + ' rawType=' + rawType + ' displayType=' + displayType);
					break;
			}
		}

		// load approval summary separately because approvals are not stored in u_daily_digest_item
		var approvalSummary = this.getPendingApprovalsSummary(userID);

		// populate approval section rows
		sections.approval = approvalSummary.rows;

		// compute the total number of individual comments represented by aggregated comment rows
		var commentTotal = this.sumItemCounts(sections.comment);

		// recalculate the displayed item count more precisely for the run
		var totalShownCount = sections.opened.length + sections.assigned.length + commentTotal + sections.closed.length + approvalSummary.total;

		// build the email subject
		var subject = 'Your daily digest - ' + digestDate;

		// start building the email HTML body
		var html = '';

		// embed the run token in an HTML comment for correlation
		html += '<!-- DAILY_DIGEST_RUN:' + this.sanitizeIllegalChars(runToken) + ' -->';

		// for safety: also embed it in a hidden visible element because some mail flows strip comments
		html += '<div style="display:none !important;font-size:1px;color:#ffffff;max-height:0;max-width:0;opacity:0;overflow:hidden">';
		html += 'DAILY_DIGEST_RUN:' + this.sanitizeIllegalChars(runToken);
		html += '</div>';

		// start of the main email div container
		html += '<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#111">';

		// header title
		html += '<h2 style="margin:0 0 6px 0">Daily Summary</h2>';

		// intro block with recipient and digest date
		html += '<div style="color:#555;margin-bottom:14px">';
		html += 'For <b>' + this.sanitizeIllegalChars(user.getDisplayValue()) + '</b><br/>';
		html += 'Date: ' + this.sanitizeIllegalChars(digestDate);
		html += '</div>';

		// highlights summary box
		html += '<div style="padding:10px;border:1px solid #e6e6e6;border-radius:8px;margin-bottom:14px">';
		html += '<b>Highlights</b><br/>';
		html += 'Opened: ' + sections.opened.length + ' | ';
		html += 'Assigned: ' + sections.assigned.length + ' | ';
		html += 'Comments: ' + commentTotal + ' | ';
		html += 'Closed: ' + sections.closed.length + ' | ';
		html += 'Pending approvals: ' + approvalSummary.total;
		html += '</div>';

		// append each section if it has items
		html += this.sectionHTML('Cases opened by you', sections.opened, false, moreURLs.opened);
		html += this.sectionHTML('Cases assigned to you', sections.assigned, false, moreURLs.assigned);
		html += this.sectionHTML('Cases commented on (by others)', sections.comment, true, moreURLs.comment);
		html += this.sectionHTML('Cases closed', sections.closed, false, moreURLs.closed);
		html += this.approvalSectionHTML(sections.approval, approvalSummary.total, moreURLs.approval);

		// build the unsub URL
		var unsubscribeURL = this.baseURL + '/daily_digest_unsubscribe.do';

		// footer notes
		html += '<div style="margin-top:16px;color:#777;font-size:12px">';
		html += '<a href="' + unsubscribeURL + '">Unsubscribe</a>';
		html += '</div>';

		// end of the main email div container
		html += '</div>';

		// return the completed mail object
		return {
			subject: subject,
			html: html
		};
	},

	type: 'DailyDigestEmailBuilder'
};