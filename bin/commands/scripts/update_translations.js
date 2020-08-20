var https = require("https");
var request = require("request");
var fs = require('fs');
var path = require("path");
var dir = path.resolve(__dirname, '../../../');
var manager = require('../../../plugins/pluginManager.js');

var header = "# DO NOT EDIT THIS FILE AS IT WILL BE OVERRIDEN DURING TRANSLATION SYNC\n" +
             "# IF YOU WOULD LIKE TO HELP COUNTLY TO BE TRANSLATED INTO YOUR LANGUAGE\n" +
             "# PLEASE VISIT https://www.transifex.com/osoner/countly\n\n";

var default_langs = [{"language_code": "ar"}, {"language_code": "bs_BA"}, {"language_code": "my"}, {"language_code": "ca"}, {"language_code": "zh_CN"}, {"language_code": "nl_NL"}, {"language_code": "et"}, {"language_code": "fr"}, {"language_code": "de"}, {"language_code": "el"}, {"language_code": "hi"}, {"language_code": "it"}, {"language_code": "ja"}, {"language_code": "ko"}, {"language_code": "lv_LV"}, {"language_code": "nb_NO"}, {"language_code": "fa"}, {"language_code": "pl_PL"}, {"language_code": "pt_BR"}, {"language_code": "ro"}, {"language_code": "ru"}, {"language_code": "sl_SI"}, {"language_code": "es"}, {"language_code": "sv"}, {"language_code": "tr"}, {"language_code": "uk"}, {"language_code": "vi"}, {"language_code": "vi_VN"}, {"language_code": "hu"}];

// Create auth credentials buffer only once.
var auth = "Basic " + Buffer.from("countly:countly").toString("base64");

// Agent will take care of the following:
var agent = new https.Agent({
    keepAlive: true, // keeping connection alive to save handshake overhead
    maxSockets: 50 // handling queue of requests, processing <maxSockets> at a time
});

// Each failed call to 'makeRequest' will retry this amout of times (except for 4XX cases, which are not retried).
var MAX_TRY_COUNT = 3;
// Inteval before retrying, in milliseconds.
var RETRY_INTERVAL = 1000;

function makeRequest(url, optional, callback) {
    var options = {
        uri: url,
        method: 'GET',
        headers: {
            "Authorization": auth
        },
        agent: agent
    };

    var tryCount = 0;
    var handler;

    // Preparing a retry function that closures the request handler in order to re-run the same logic when retrying.
    var retry = function(error) {
        if (tryCount >= MAX_TRY_COUNT) {
            console.log("Failed to fetch '" + url + "' " + tryCount + " time(s)");
            // Call the final callback with the last error.
            // If a higher accuracy is required, it would be possible to enqueue previous errors,
            // and then throw an aggregate error containing all of them.
            return callback(error);
        }

        tryCount += 1;

        setTimeout(function() {
            console.log("Retrying to fetch '" + url + "' (" + tryCount + "/" + MAX_TRY_COUNT + ")");
            request(options, handler);
        }, RETRY_INTERVAL);
    };

    // Error handling and retrying mechanism is handled here,
    // so the function makeRequest doesn't have to handle it and get all this for free.
    handler = function(error, response, body) {
        // Avoid retrying on 4XX
        if (response && response.statusCode >= 400 && response.statusCode <= 499) {
            return callback(error);
        }
        // Merge error and non-2XX response into a single error for the next layer.
        if (error || response.statusCode < 200 || response.statusCode > 299) {
            if (!error) {
                error = new Error("HTTP error " + response.statusCode);
                // Insert statusCode in the error in case it would be
                // use later on to conditionally perform action.
                error.statusCode = response.statusCode;
            }
            return retry(error);
        }

        var data;

        try {
            data = JSON.parse(body);
        }
        catch (ex) {
            console.error("Failed to parse JSON for url '" + url + "'");
            // Avoid retrying on response parsing failure.
            return callback(ex);
        }

        if (!data && !optional) {
            // Retry if we couldn't get data when it is mandatory.
            retry(new Error("No response data"));
        }
        else {
            // We got the data, raise the final callback.
            callback(error, data);
        }
    };

    // Ignite the first call.
    request(options, handler);
}

// This is used to keep track of what has been written to disk.
var safeChecks = {};

// Have to register to process exit event since we are triggering a bunch of fire-and-forget actions,
// and have no idea when all that will end.
process.on("exit", function() {
    var i;
    var keys = Object.keys(safeChecks);

    console.log(keys.length + " update failures");

    // Print all remaining keys, meaning those are failures.
    for (i = 0; i < keys.length; i += 1) {
        if (safeChecks[keys[i]]) {
            console.error("Failed to update " + keys[i]);
        }
    }
});

function getFile(resource, language) {
    var parts = resource.name.split(".");
    var location = dir;
    if (resource.slug == "dashboardproperties") {
        location += "/frontend/express/public/localization/dashboard/";
    }
    else if (resource.slug == "pre-loginproperties") {
        location += "/frontend/express/public/localization/pre-login/";
    }
    else if (resource.slug == "mailproperties") {
        location += "/frontend/express/public/localization/mail/";
    }
    else if (resource.slug == "helpproperties_1") {
        location += "/frontend/express/public/localization/help/";
    }
    else {
        location += "/plugins/" + parts[0] + "/frontend/public/localization/";
    }

    // Make sure the file system location we are targeting exists and is a directory.
    fs.stat(location, function(err, stats) {
        if (err) {
            // Skip without printing error because this happens often and is expected.
            return;
        }
        if (!stats.isDirectory()) {
            console.error("'" + location + "' is not a directory");
            return;
        }

        // Construct a safe check key to be reused.
        var safeCheckKey = resource.name + "_" + language.language_code;
        safeChecks[safeCheckKey] = true;

        // Requesting this resource, response data is optional.
        makeRequest("https://www.transifex.com/api/2/project/countly/resource/" + resource.slug + "/stats/" + language.language_code + "/", true, function(err, stats) {
            if (err) {
                console.log("error " + resource.name + " for " + language.language_code, err);
                return;
            }

            // When the remote resource does not exists, or is empty, skip it.
            if (!stats || stats.completed === "0%") {
                delete safeChecks[safeCheckKey];
                return;
            }

            console.log("Updating " + resource.name + " for " + language.language_code);

            // Requesting this resource, response data is mandatory.
            makeRequest("https://www.transifex.com/api/2/project/countly/resource/" + resource.slug + "/translation/" + language.language_code + "/", false, function(err, file) {
                if (err) {
                    console.log("ignoring " + resource.slug + ": " + err);
                    return;
                }

                // Construct filename conditionally.
                let filename;
                if (resource.source_language_code == language.language_code) {
                    filename = location + resource.name;
                }
                else {
                    var code = language.language_code.split("_")[0];
                    filename = location + parts[0] + "_" + code + "." + parts[1];
                }

                // Write the downloaded data to the file system.
                fs.writeFile(filename, header + file.content, function(err) {
                    if (err) {
                        return console.log(err);
                    }
                    console.log("Updated " + resource.name + " for " + language.language_code);
                    delete safeChecks[safeCheckKey];
                });
            });
        });
    });
}

manager.dbConnection().then((db) => {
    manager.loadConfigs(db, function() {
        if (!manager.getConfig("api").offline_mode) {
            //get resources
            // Requesting this resource, response data is mandatory.
            makeRequest("https://www.transifex.com/api/2/project/countly/resources/", false, function(err, resources) {
                if (err) {
                    console.log("Can't update translations: " + err);
                    return;
                }
                // Keep this for future improvements.
                // Possibly having command arguments to update only specific languages, or skip some specific languages updates.
                var languages = default_langs.filter(function(l) {
                    if (l.language_code === "en") {
                        return false;
                    }
                    return true;
                });
                //get translation files
                // Ignite all requests, the agent is going to queue and process them automatically.
                for (var i = 0; i < resources.length; i++) {
                    for (var j = 0; j < languages.length; j++) {
                        getFile(resources[i], languages[j]);
                    }
                }
            });
            db.close();
        }
        else {
            console.log("Server is in offline mode, will not attempt to update translations");
            db.close();
        }
    });
});