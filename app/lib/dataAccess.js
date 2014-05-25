var couch 	= require('./couch.js');
var encrypt = require('./encrypt.js');
var uuid 	= require('node-uuid');
var events  = require('events');

var db = function() {
	var ee = new events.EventEmitter();

	var addCircle = function (circle, callback) {
		var newCircle = {
			name: circle.name
		};

		couch.circles.add(newCircle, function (err, body) {
			if (err) {
				return callback(err);
			}

			newCircle._id = body.id;
			newCircle._rev = body.rev;
			callback(null, newCircle);
		});
	};

	var updateCircle = function (circle, callback) {
		couch.circles.update(circle, callback);
	};


	var addGroup = function(group, success, failure) {
		var newGroup = {
			name: group.name,
			projectId: group.projectId,
			isPermanent: group.isPermanent
		};
		
		couch.groups.add(newGroup, function (err, body) {
			if (err) {
				return failure(err);
			}
			// TODO: what to return?
			success(body);
		});
	};

	var removeGroup = function(group, success, failure) {
		couch.groups.remove(group, function (err, body) {
			if (err) {
				return failure(err);
			}

			return success();
		});
	};

	var findGroupById = function (groupId, callback) {
		// TODO: Make the other get-by-id functions like this, perhaps.
		couch.docs.get(groupId, function (err, body) {
			if (err) {
				return callback(err);
			}

			if (body.type === "group") {
				return callback(null, body);
			}
			else {
				return callback({
					message: "Document is not a group: " + groupId
				});
			}
		});
	};

	var findGroupsByProjectId = function (projectId, callback) {

		var prepareGroups = function (err, dbGroups) {
			if (err) {
				return callback(err);
			}

			var groups = [];
			dbGroups.forEach(function (group, index, array) {
				// TODO: Not sure we need this modelGroup
				// business, except to cause more work
				// in the future.
				var modelGroup = {
					id: group._id,
					projectId: group.projectId,
					name: group.name,
					isPermanent: group.isPermanent
				};

				groups.push(modelGroup);
			});

			callback(err, groups);
		};

		couch.groups.findByProjectId(projectId, prepareGroups);
	};

	var findGroupsByUser = function(user, callback) {
		couch.groups.findByUser(user, callback);
	};

	var isFirstStoryCreated = function (story) {
		return !story.nextId;
	};

	var getLastId = function (story) {
		return ("last-" + story.projectId);
	}

	var isLastStory = function (story) {
		return story.nextId === getLastId(story);
	};

	var findStoriesByProjectId = function (projectId, callback) {

		var prepareStories = function (err, dbStories) {
			if (err) {
				return callback(err);
			}

			var stories = {};
			dbStories.forEach(function (story, index, array) {
				// TODO: Not sure we need this modelStory
				// business, except to cause more work
				// in the future.
				var modelStory = {
					id: story._id,
					projectId: story.projectId,
					nextId: story.nextId || getLastId(story),
					isFirstStory: story.isFirstStory,

					summary: story.summary,
					owner: story.owner,
					status: story.status,
					description: story.description,
					isDeadline: story.isDeadline,
					isNextMeeting: story.isNextMeeting,
					createdBy: story.createdBy,
					comments: story.comments,
					isOwnerNotified: story.isOwnerNotified
				};

				stories[modelStory.id] = modelStory;	

				// If there is nothing 'next', we're done.
				// TODO: Maybe. 
				// TODO: This assumes our data is all valid.
				if (isLastStory(modelStory)) {
					return false;
				}

				return true;
			});

			callback(err, stories);
		};

		couch.stories.findByProjectId(projectId, prepareStories);
	};

	var findStoriesByNextId = function (nextId, callback) {
		couch.stories.findByNextId(nextId, callback);
	};


	var postInsertStory = function (story, nextId, success, failure) {
		// Find the 'next' story. If the 'next' story is the
		// 'first' story, well, now our story is the first story
		// and the next story is not.
		couch.stories.findById(nextId, function (err, nextStory) {
			
			if (err) {
				console.log("Update-story-metadata: Failure to find by id");
				return failure(err);
			}

			if (!nextStory) {
				story.isFirstStory = true;
				return updateStory(story, success, failure); 
			}

			if (story.id === nextStory.id) {
				return failure({
					message: "Post-insert: Circular reference detected"
				});
			}

			var storiesToSave = {};
			story.nextId = nextId;

			var saveStories = function () {
				couch.stories.transaction(storiesToSave, function (err, response) {
					if (err) {
						return failure(err);
					}
					return success(story);
				});
			};

			if (nextStory.isFirstStory) {
				nextStory.isFirstStory = false;
				story.isFirstStory = true;
				
				storiesToSave[nextStory.id] = nextStory;
				storiesToSave[story.id] = story;

				saveStories();
			}
			else {
				console.log("Next story IS NOT first story ...");
				console.log(nextStory);
				
				storiesToSave[story.id] = story;

				couch.stories.findByNextId(nextId, function (err, previousStory) {
					if (err) {
						failure(err);
					}
					else {
						if (previousStory.nextId === story.id) {
							// Fine.
						}
						else {
							previousStory.nextId = story.id;
							storiesToSave[previousStory.id] = previousStory;
						}
						saveStories();
					}
				});
			}
		});
	};


	var getNextIdForInsert = function (story, proposedNextId, callback) {

		var foundNextId = function (nextId) {
			callback(null, nextId);
		};

		var failure = function (err) {
			callback(err, null);
		};

		if (isFirstStoryCreated(story) && !proposedNextId) {
			if (story.isNextMeeting) {
				// Ok, we're actually the first story created.
				foundNextId(getLastId(story));
			}
			else {
				// This probably means the first story was not specified.
				// Put it at the top of the backlog.
				getFirstStory(story.projectId, function (err, firstStory) {
					if (err) {
						return failure(err);
					}
					getNextIdForInsert(story, firstStory._id, callback);
				});
			}
		}
		else { 
			// story.nextId exists
			//
			// Look to see if there is already a story in the database
			// that is already pointing to the 'next' story we want to
			// point to.
			findStoriesByNextId(proposedNextId, function (err, conflicts) {
				if (err) {
					console.log("Add: Failure to find by next id.");
					return failure(err);
				}

				if (conflicts.length === 0) {
					return foundNextId(proposedNextId);
				}

				if (conflicts.length === 1) {
					// One other story is pointing to the same 'next'
					// story as we are. Cool. Let's point THAT story
					// for our 'next' story.

					// TODO: Don't use raw CouchDB stories.
					// In other words, we don't keep 'id' fields in the
					// database, and so we'll run into problems if we
					// just use the raw data.
					//
					// However, it's fine for now. (April 11)
					var conflict = conflicts[0];
					conflict.id = conflict._id;

					if (story.id !== conflict.id) {
						console.log("CONFLICT RESOLUTION");
						console.log(story.summary + " ----> " + conflict.summary);
						// It is possible there are conflicts with this new nextId,
						// so enter another addStory process.
						return getNextIdForInsert(story, conflict.id, callback);
					}
					else {
						// Rather than create an infinite next-pointer
						// loop, let's fail the call.
						return failure({
							message: "Story is already present in database. You're probably fine?", 
							story_id: story.id
						});
					}
				}
				else {
					// There are too many things happening! It probably means
					// there are more than two people trying to add new stories
					// to the same project at the same time.
					// 
					// This situation should resolve itself if we just wait.
					// If it does not, well, there's a defect in our system.
					return failure({
						message: "Too many nextId conflicts. Doing nothing. " + 
							"We suggest waiting a few seconds and trying again.",
						story_id: story.id
					});
				}			
			});	
		}
	};

	var activeStoryQueue = {};
	var isStoryQueueRunning = false;

	var processStoryQueue = function () {
		isStoryQueueRunning = true;

		var stopProcessing = function () {
			isStoryQueueRunning = false;
			var err = {
				error: 'halted queue',
				message: "Story processing queue halted. Please try again."
			};
			for (var storyId in activeStoryQueue) {
				ee.emit(storyId, err, null);
			}
		};

		var notifyListeners = function (err, story) {
			delete activeStoryQueue[story._id];
			ee.emit(story._id, err, story);
		};

		var processNextInQueue = function () {	
			// while queue exists:
			// 1. process first story in queue.
			// 2. remove first story (implicitly, via update).
			couch.stories.nextInQueue(function (err, storyToProcess) {
				if (err) {
					console.log('queue: next-in-queue failure');
					console.log(err);
					notifyListeners(err, storyToProcess);
					stopProcessing();
					return;
				}

				if (storyToProcess === null) {
					stopProcessing();
					return;
				}

				var proposedNextId = storyToProcess.nextId || null;
				
				storyToProcess.id = storyToProcess._id;
				storyToProcess.type = "story";

				getNextIdForInsert(storyToProcess, proposedNextId, function (err, nextId) {
					if (err) {
						console.log("queue: get-next-id failure");
						console.log(err);
						notifyListeners(err, storyToProcess);
						// continue processing
						return;
					}
					storyToProcess.nextId = nextId;
					couch.docs.update(storyToProcess, function (err, processedStory) {
						if (err) {
							console.log('queue: update failure');
							console.log(err);
							notifyListeners(err, storyToProcess);
							stopProcessing();
							return;
						}

						postInsertStory(processedStory, processedStory.nextId, 
							function (postProcessedStory) {
								notifyListeners(null, postProcessedStory);
								processNextInQueue();
							},
							function (err) {
								console.log('queue: post-insert failure');
								console.log(err);
								notifyListeners(err, processedStory);
								stopProcessing();
							}
						);
					});
				});
			});
		}; 

		processNextInQueue();
	};

	var addStory = function (story, callback) {
		couch.stories.addToQueue(story, function (err, body) {
			if (err) {
				return callback(err);
			}

			activeStoryQueue[body.id] = body.id;
			ee.once(body.id, function (err, story) {
				callback(err, story);
			});

			if (!isStoryQueueRunning) {
				processStoryQueue();
			}
		});
	};

	var getFirstStory = function (projectId, callback) {
		if (!projectId) {
			callback(null, null);
		}

		couch.stories.findFirst(projectId, callback);
	};

	var getNextMeeting = function (projectId, callback) {
		if (!projectId) {
			callback(null, null);
		}

		couch.stories.findNextMeeting(projectId, callback);
	};


	var moveStory = function (story, newNextId, success, failure) {
		var storiesToSave = {};
		var addToStoriesToSave = function (s) {
			if (s) {
				if (storiesToSave[s.id]) {
					// This is a coding error and if it happens
					// there is a fixable issue below. Or maybe
					// rewrite this function so it is better.
					console.log("DUPLICATE SAVE. DOC CONFLICT. INTEGRITY BROKEN.");
					console.log(storiesToSave[s.id]);
					console.log(s);
				}
				storiesToSave[s.id] = s;
			}
		};

		var saveStories = function () {
			couch.stories.transaction(storiesToSave, function (err, response) {
				if (err) {
					// We maybe had some document conflicts and should
					// probably just try again.
					return failure(err);
				}
				success(story);
			});
		};

		couch.stories.findById(story.id, function (err, storyToMove) {
			if (err) {
				return failure(err);
			}
			if (!storyToMove) {
				return failure({
					message: "Sorry, the story you're trying to move was deleted by someone else.",
					story: story
				});
			}

			var lastId = getLastId(storyToMove);
			couch.stories.findByNextId(storyToMove.id, function (err, preMovePreviousStory) {
				if (err) {
					return failure(err);
				}
				couch.stories.findByNextId(newNextId, function (err, storyC) {
					if (err) {
						return failure(err);
					}
					couch.stories.findById(newNextId, function (err, storyE) {
						if (err) {
							return failure(err);
						}
						if (!storyE && newNextId !== lastId) {
							return failure({
								message: "Someone deleted the story you're trying "
								+ "to put this one in front of. Maybe refresh your story list "
								+ "and try again.",
								story: story
							});
						}
						couch.stories.findById(storyToMove.nextId, function (err, preMoveNextStory) {
							if (err) {
								return failure(err);
							}
							// This might happen if there is a ton of activity, I guess.
							if (!preMoveNextStory && storyToMove.nextId !== lastId) {
								return failure({
									message: "There is a lot of activity on the project. " +
									"Wait a little bit and try again.",
									story: story
								});
							}

							getFirstStory(storyToMove.projectId, function (err, firstStory) {
								if (err) {
									return (failure);
								}

								// preMovePreviousStory ---> storyToMove ---> ... ---> storyC --> newLocation
								// TODO: We can parallelize this

								// Assume everything is found how we want it.
								preMovePreviousStory = preMovePreviousStory ? preMovePreviousStory[0] : null;
								storyC = storyC ? storyC[0] : null;
								storyE = storyE ? storyE[0] : null;

								if (preMovePreviousStory) {
									// base case
									preMovePreviousStory.nextId = storyToMove.nextId;	
									addToStoriesToSave(preMovePreviousStory);
								}
								else if (preMoveNextStory) {
									// if there is no preMovePreviousStory, that
									// means storyToMove is the first story.
									//
									// So, the new first story is the preMoveNextStory.
									storyToMove.isFirstStory = false;
									preMoveNextStory.isFirstStory = true;
									addToStoriesToSave(preMoveNextStory);									
								}
								
								storyToMove.nextId = newNextId;

								if (storyC) {
									// base case
									storyC.nextId = storyToMove.id;
									if (storiesToSave[storyC.id]) {
										storiesToSave[storyC.id].nextId = storyToMove.id;
									}
									else {
										storyC.nextId = storyToMove.id;
										addToStoriesToSave(storyC);	
									}
								}
								else {
									// storyToMove is moved to the first spot
									storyToMove.isFirstStory = true;
									// Sometimes preMovePreviousStory and FirstStory are the same.
									if (storiesToSave[firstStory.id]) {
										storiesToSave[firstStory.id].isFirstStory = false;
									}
									else {
										firstStory.isFirstStory = false;
										addToStoriesToSave(firstStory);	
									}
								}

								addToStoriesToSave(storyToMove);
								saveStories();
							});
						});
					});
				});
			});
		});
	};

	var removeStory = function (story, success, failure) {

		couch.stories.findById(story.id, function (err, storyToRemove) {
			if (err) {
				return failure(err);
			}

			if (!storyToRemove) {
				// Story is already gone!
				return success();			
			}

			couch.stories.findByNextId(storyToRemove.id, function (err, previousStory) {
				if (err) {
					return failure(err);
				}

				couch.stories.findById(storyToRemove.nextId, function (err, nextStory) {
					if (err) {
						return failure(err);
					}

					var lastId = getLastId(storyToRemove);
					if (storyToRemove.nextId === lastId) {
						nextStory = {};
						nextStory.id = lastId;
					}
					else if (!nextStory) {
						// Someone deleted the nextStory before we could access it.
						// Server usage is heavy.
						return failure({
							message: "There is a lot of activity on the server right now. " 
							+ "Wait a little and try again."
						});
					}

					previousStory = previousStory ? previousStory[0] : null;

					var storyToSave;
					if (previousStory) {
						// most-common case
						previousStory.nextId = nextStory.id;
						storyToSave = previousStory;
					}
					else if (nextStory) {
						// TODO: assert(storyToRemove.isFirstStory);
						nextStory.isFirstStory = true;
						storyToSave = nextStory;
					}
					else {
						// nothing to do.
						return success();
					}

					couch.stories.update(storyToSave, function (err) {
						if (err) {
							return failure(err);
						}
						couch.stories.remove(story, function (err) {
							if (err) {
								return failure(err);
							}
							return success();
						});
					});
				});
			});
		});
	};

	var updateStory = function(story, success, failure) {
		couch.stories.update(story, function (err, body) {
			if (err) {
				// TODO: Clean this up
				console.log("Update-Story: Failure to update.");
				Error.stackTraceLimit = Infinity;
				// throw new Error("whwwwttat");
				return failure(err);
			}
			story._rev = body.rev;
			success(story);
		});
	};

	var markStoryOwnerNotified = function (story, success, failure) {
		couch.stories.findById(story.id, function (err, storyToSave) {
			if (err) {
				return failure(err);
			}

			storyToSave.isOwnerNotified = true;
			updateStory(storyToSave, success, failure);
		});
	};

	// 'Saving' a story is for persisting the things that a guest
	// would consider part of a story, like the summary and who
	// it is assigned to. Not for saving internal data.
	var saveStory = function (story, success, failure) {
		couch.stories.findById(story.id, function (err, storyToSave) {
			if (err) {
				return failure(err);
			}

			storyToSave.summary = story.summary;
			storyToSave.owner = story.owner;
			storyToSave.status = story.status || "";
			storyToSave.description = story.description;
			// isDeadline should not be changed
			// storyToSave.isDeadline = story.isDeadline;

			if (story.newComment) {
				storyToSave.comments = storyToSave.comments || [];
				storyToSave.comments.push(story.newComment);
			}

			updateStory(storyToSave, success, failure);
		});
	};


	var addStoriesToArchive = function (stories, success, failure) {
		var count = 0;
		var archives = [];

		var storyIds = [];
		stories.forEach(function (story) {
			storyIds.push(story.id);
		});

		couch.stories.findMany(storyIds, function (err, body) {
			if (err) {
				return failure(err);
			}

			var storiesToArchive = [];
			body.rows.forEach(function (record) {
				if (record.doc.type === "story") {
					storiesToArchive.push(record.doc);	
				}
			});;

			storiesToArchive.forEach(function (story) {
				var archive = {};

				archive.storyId = story.id;
				archive.projectId = story.projectId;
				archive.summary = story.summary;
				archive.owner = story.owner;
				archive.status = story.status;
				archive.description = story.description;
				archive.comments = story.comments || [];

				archive.isDeadline = story.isDeadline;
				archive.createdBy = story.createdBy;

				archive.timestamp = Date.now();
				archive.sortIndex = "" + archive.timestamp + "." + count;
				count++;

				archives.push(archive);
			});

			couch.archives.add(archives, function (err, body) {
				if (err) {
					return failure(err);
				}

				return success(body);
			});
		});
	};

	var findArchivesByCircleId = function (circleId, callback) {
		couch.archives.findByCircleId(circleId, callback);
	};


	var isValidUser = function(user) {
		return user && user.email && user.id;
	};

	var findUserByEmail = function(userEmail, callback) {
		if (userEmail) {
			userEmail = userEmail.toLowerCase();
		}
		couch.users.findByEmail(userEmail, callback);
	};

	var findUserById = function(id, callback) {
		couch.users.findById(id, callback);
	};

	var findUserByName = function (name, callback) {
		couch.users.findByName(name, callback);
	};

	var findUsersByCircleId = function (circleId, callback) {
		couch.users.findByCircleId(circleId, callback);
	};

	var findNamesByCircleId = function (circleId, callback) {
		couch.users.findNamesByCircleId(circleId, callback);
	};

	var findUsersById = function (idArray, callback) {
		couch.users.findMany(idArray, callback);
	};

	var normalizeUser = function (user) {
		if (user.email) {
			user.email = user.email.toLowerCase();
		}
		if (user.notifications && user.notifications.email) {
			user.notifications.email = user.notifications.email.toLowerCase();
		}

		return user;
	}

	// TODO: Refactor this to have one parameter for the user.
	var addUser = function(name, email, password, memberships, isReadOnly, success, failure) {
		var user = {
			name: name,
			email: email,
			id: uuid.v4(),
			memberships: memberships,
			isReadOnly: isReadOnly
		};
		
		if (!isValidUser(user)) {
			return failure("User cannot be null?");
		}

		var addUser = function (user, password) {
			user = normalizeUser(user);
			couch.users.add(user, password, function (err, body) {
				if (err) {
					return failure(err);
				}

				user._id = body.id;
				user._rev = body.rev;
				success(user);	
			});
		};

		findUserById(user.id, function (err, body) {
			// TODO: Handle db errors.
			if (body) {
				// TODO: Error codes, etc.
				// This is an internal error.
				return failure("User already exists.");
			}
			findUserByEmail(user.email, function (err, body) {
				if (body) {
					//TODO: Error?
					// This is an external error.
					return failure("User email already exists");
				}
				addUser(user, password);
			});
		});
	};
	
	var removeUser = function(user, success, failure) {
		if (!(user && user.email)) {
			return failure("User not found.");
		}

		couch.users.remove(user, function (err, body) {
			if (err) {
				return failure(err);
			}
			return success();
		});
	};

	var updateUser = function(user, success, failure) {
		if (!isValidUser(user)) {
			return failure();
		}

		user = normalizeUser(user);
		couch.users.update(user, function (err, body) {
			if (err) {
				return failure(err);
			}
			user._rev = body.rev;
			success(user);
		});
	};

	var updateUserPassword = function(user, password, success, failure) {
		if (!isValidUser(user)) {
			return failure("Need a valid user. Sorry.");
		}

		couch.users.updatePassword(user, password, function (err) {
			if (err) {
				return failure(err);
			}
			success();
		});
	};

	var validateUserPassword = function(user, password, success, failure) {
		if(!isValidUser(user)) {
			return failure();
		}

		couch.passwords.findById(user.id, function (err, pass) {
			if (err || !pass) {
				return failure();
			}

			var salt = pass.salt;
			var hash = pass.hash;	
			if(encrypt.hash(password, salt) === hash) {
				return success();
			}
			return failure();
		});
	};


	var addSetting = function(setting, success, failure) {
		var newSetting = {
			name: setting.name,
			value: setting.value,
			visibility: setting.visibility || "private"
		};
		
		couch.settings.add(newSetting, function (err, body) {
			if (err) {
				return failure(err);
			}
			// TODO: what to return?
			success(body);
		});
	};

	var handleNewDemoSetting = function (newValue, success, failure) {
		// TODO: This should probably be in a different place, like
		// a settings-specific file.
		var demoEmail = "demo@circleblvd.org";
		if (newValue) {
			// Demo mode is turned on!
			// name, email, password, memberships, isReadOnly, success, failure
			addUser("Public Demo", demoEmail, "public", [], true, success, failure);
		}
		else {
			// Demo mode is turned off!
			findUserByEmail(demoEmail, function (err, user) {
				if (err) {
					return failure(err);
				}
				removeUser(user, success, failure);
			});
		}
	};

	var saveSetting = function(setting, success, failure) {
		couch.settings.update(setting, function (err, newSetting) {
			if (err) {
				return failure(err);
			}

			if (newSetting.name === "demo") {
				// TODO: The transactional nature of this code
				// has the potential to break things, but they 
				// can probably be fixed through the admin panel.
				return handleNewDemoSetting(newSetting.value, 
					function() {
						success(setting);
					},
					failure);
			}
			else {
				return success(newSetting);
			}
		});
	};

	var getSettings = function (success, failure) {
		couch.settings.get(function (err, settings) {
			if (err) {
				return failure(err);
			}
			else {
				return success(settings);
			}
		});
	};

	var getAuthorizedSettings = function (success, failure) {
		couch.settings.getAuthorized(function (err, settings) {
			if (err) {
				return failure(err);
			}
			else {
				return success(settings);
			}
		});
	};

	var getPrivateSettings = function (success, failure) {
		couch.settings.getPrivate(function (err, settings) {
			if (err) {
				return failure(err);
			}
			else {
				return success(settings);
			}
		});
	};

	var getAllSettings = function (success, failure) {
		couch.settings.getAll(function (err, settings) {
			if (err) {
				return failure(err);
			}
			else {
				return success(settings);
			}
		});
	};


	return {
		whenReady: couch.database.whenReady,
		settings: {
			add: addSetting,
			get: getSettings,
			getAuthorized: getAuthorizedSettings,
			getPrivate: getPrivateSettings,
			getAll: getAllSettings,
			save: saveSetting
		},
		circles: {
			add: addCircle,
			getAll: function (callback) {
				couch.circles.getAll(callback);
			},
			findByUser: function (user, callback) {
				couch.circles.findByUser(user, callback);
			},
			update: updateCircle
		},
		groups: {
			add: addGroup,
			remove: removeGroup,
			findById: findGroupById,
			findByProjectId: findGroupsByProjectId,
			findByUser: findGroupsByUser
		},
		stories: {
			add: addStory,
			markOwnerNotified: markStoryOwnerNotified,
			move: moveStory,
			remove: removeStory,
			findByProjectId: findStoriesByProjectId,
			// TODO: Maybe don't return the raw database object
			getFirstByProjectId: getFirstStory,
			getNextMeetingByProjectId: getNextMeeting,
			save: saveStory
		},
		archives: {
			addStories: addStoriesToArchive,
			findByCircleId: findArchivesByCircleId
		},
		users: { 
			add: addUser,
			remove: removeUser,
			findByEmail: findUserByEmail,
			findById: findUserById, 
			findByName: findUserByName,
			findByCircleId: findUsersByCircleId,
			findNamesByCircleId: findNamesByCircleId,
			findMany: findUsersById,
			update: updateUser,
			updatePassword: updateUserPassword,
			validatePassword: validateUserPassword,
			getAll: function(callback) {
				couch.users.getAll(callback);
			},
			count: function(callback) {
				couch.users.getAll(function (err, users) {
					var userCount = users ? users.length : null;
					callback(err, userCount);
				});
			}
		}
	};
}();


exports.instance = function() {
	return db;
};
