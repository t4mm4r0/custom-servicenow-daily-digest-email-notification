// script include responsible for retrieving or storing utilities and configurations related to the custom daily digest
var DailyDigestConfig = Class.create();

DailyDigestConfig.prototype = {
	initialize: function () {
	},

	// utility function to take a comma separated string and convert it into an array of trimmed values
	// example: "incident,problem,sc_req_item" -> ["incident", "problem", "sc_req_item"]
	str2arr: function (str) {
		// start with an empty array
		var out = [];

		// force the input into a string safely (this protects against null or undefined values)
		var raw = (str || '') + '';

		// if the input is empty return an empty array
		if (!raw) {
			return out;
		}

		// split the comma separated string into pieces
		var parts = raw.split(',');

		// loop through every piece
		for (var i = 0; i < parts.length; i++) {
			// convert the current part into a string safely
			var value = (parts[i] || '') + '';

			// trim leading and trailing whitespaces
			value = value.trim();

			// only push non empty values into the final array
			if (value) {
				out.push(value);
			}
		}

		// return the array in a proper format
		return out;
	},

	// read the system property that lists the source tables to monitor for the custom daily digest
	getSourceTables: function () {
		return this.str2arr(gs.getProperty('daily_digest.source_tables', 'incident,problem,sc_req_item'));
	},

	// read the system property that lists the journal element types to include
	getJournalElementTypes: function () {
		return this.str2arr(gs.getProperty('daily_digest.journal_element_types', 'comments'));
	},

	// read the system property that has the configured default user local send time for the daily digest
	getDefaultSendTime: function () {
		return gs.getProperty('daily_digest.default_send_time', '17:00:00');
	},

	// read the system property that has the configured queue timeout in minutes
	// this is the age after which a ready/queued run is considered stale and recoverable
	getQueueTimeoutMinutes: function () {
		// parse the property value into an integer
		var value = parseInt(gs.getProperty('daily_digest.queue_timeout_minutes', '120'), 10);

		// if parsing fail or the value is too small to be sensible fall back to 120 minutes
		if (isNaN(value) || value < 1) {
			value = 120;
		}

		// return the timeout
		return value;
	},

	// retrieve the base instance URL used in email links
	getBaseURL: function () {
		// first try the email override URL if configured
		var url = gs.getProperty('glide.email.override.url');

		// if not set fall back to the main servlet URI
		if (!url) {
			url = gs.getProperty('glide.servlet.uri');
		}

		// convert into string
		url = (url || '') + '';

		// remove trailing slashes so later URL concatenation stays clean
		// example: "https://instance.service-now.com/" -> "https://instance.service-now.com"
		url = url.replace(/\/+$/, '');

		// return the cleaned URL
		return url;
	},
	
	type: 'DailyDigestConfig'
};