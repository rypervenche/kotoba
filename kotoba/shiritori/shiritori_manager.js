'use strict'
const reload = require('require-reload')(require);
const wordData = reload('./shiritori_word_data.js');

const LOGGER_TITLE = 'QUIZ';

const INITIAL_DELAY_IN_MS = 5000;
const REVEAL_INTERVAL_IN_MS = 8000;
const MAX_SAVES_PER_USER = 5;
const MINIMUM_ANSWER_LIMIT_IN_MS = 4000;
const END_STATUS_ERROR = 1;

/* LOADING AND INITIALIZATION */

if (!state.shiritoriManager) {
  state.shiritoriManager = {
    currentActionForLocationId: {},
    sessionForLocationId: {},
    reviewDeckForLocationId: {},
    reviewDeckForUserId: {},
  };
}

/* STOPPING */

function closeSession(session, gameOver) {
  if (!session) {
    return Promise.resolve();
  }

  let locationId = session.getLocationId();

  delete state.shiritoriManager.sessionForLocationId[locationId];
  delete state.shiritoriManager.currentActionForLocationId[locationId];
  return Promise.resolve(session.finalize(gameOver));
}

function endQuiz(gameOver, session, notifier, notifyDelegate, delegateFinalArgument) {
  if (!session) {
    return Promise.resolve();
  }

  let locationId = session.getLocationId();
  if (state.shiritoriManager.currentActionForLocationId[locationId]) {
    if (state.shiritoriManager.currentActionForLocationId[locationId].stop) {
      state.shiritoriManager.currentActionForLocationId[locationId].stop();
    }
    delete state.shiritoriManager.currentActionForLocationId[locationId];
  }

  try {
    return Util.retryPromise(() => {
      return Promise.resolve(notifyDelegate.call(
        notifier,
        session.getName(),
        session.getScoresForUserPairs(),
        session.getUnansweredCards(),
        session.createAggregateUnansweredCardsLink(),
        session.getDidCreateReviewDecks(),
        delegateFinalArgument));
    }, 3).catch(err => {
      logger.logFailure(LOGGER_TITLE, 'Error ending quiz. Continuing and closing session.', err);
    }).then(() => {
      return closeSession(session, true);
    });
  } catch (err) {
    logger.logFailure(LOGGER_TITLE, 'Error ending quiz. Continuing and closing session.', err);
    return closeSession(session, true);
  }
}

function stopAllQuizzesCommand() {
  let allLocationIds = Object.keys(state.shiritoriManager.sessionForLocationId);
  let promise = Promise.resolve();
  for (let locationId of allLocationIds) {
    let session = state.shiritoriManager.sessionForLocationId[locationId];
    let messageSender = session.getMessageSender();
    promise = promise.then(() => {
      return endQuiz(true, session, messageSender, messageSender.notifyStoppingAllQuizzes);
    }).catch(err => {
      logger.logFailure(LOGGER_TITLE, 'Failed to send quiz stop message to location ID ' + locationId, err);
    });
  }

  return promise;
}

function stopQuizCommand(locationId, cancelingUserId, cancelingUserIsAdmin) {
  let session = state.shiritoriManager.sessionForLocationId[locationId];

  if (session) {
    let messageSender = session.getMessageSender();
    let gameMode = session.getGameMode();
    if (gameMode.onlyOwnerOrAdminCanStop && !cancelingUserIsAdmin && session.getOwnerId() !== cancelingUserId) {
      return Promise.resolve(messageSender.notifyStopFailedUserNotAuthorized());
    }
    return Promise.resolve(endQuiz(true, session, messageSender, messageSender.notifyQuizEndedUserCanceled, cancelingUserId));
  }
}

function skipCommand(locationId) {
  let action = state.shiritoriManager.currentActionForLocationId[locationId];
  if (action && action.skip) {
    action.skip();
    return true;
  }
  return false;
}

function saveQuizCommand(locationId, savingUserId) {
  let session = state.shiritoriManager.sessionForLocationId[locationId];
  if (!session) {
    return Promise.resolve(false);
  }
  if (session.getGameMode().isReviewMode) {
    return session.getMessageSender().notifySaveFailedIsReview();
  }
  let ownerId = session.getOwnerId();
  if (savingUserId !== ownerId) {
    return session.getMessageSender().notifySaveFailedNotOwner();
  }

  return saveManager.getSaveMementos(savingUserId).then(mementos => {
    let hasSpace = mementos.length < MAX_SAVES_PER_USER;
    if (session.saveRequestedByUserId) {
      return;
    }
    if (hasSpace) {
      session.saveRequestedByUserId = savingUserId;
      return session.getMessageSender().notifySaving();
    } else {
      return session.getMessageSender().notifySaveFailedNoSpace(MAX_SAVES_PER_USER);
    }
  });
}

function isSessionInProgressAtLocation(locationId) {
  return !!state.shiritoriManager.sessionForLocationId[locationId];
}

function setSessionForLocationId(session, locationId) {
  assert(!isSessionInProgressAtLocation(locationId), 'Already have a session for that loction ID');
  state.shiritoriManager.sessionForLocationId[locationId] = session;
}

/* ACTIONS */

class Action {
  constructor(session) {
    this.session_ = session;
  }

  getSession_() {
    return this.session_;
  }
}

class EndQuizForErrorAction extends Action {
  do() {
    const session = this.getSession_();
    try {
      logger.logFailure(LOGGER_TITLE, 'Stopping for error');
      const clientDelegate = session.getClientDelegate();
      return Promise.resolve(endQuiz(true, session, messageSender, messageSender.notifyQuizEndedError)).catch(err => {
        logger.logFailure(LOGGER_TITLE, 'Error ending quiz gracefully for error. Attempting to close session.');
        return Promise.resolve(closeSession(session, true)).then(() => {
          logger.logSuccess(LOGGER_TITLE, 'Session closed successfully.');
          throw err;
        });
      });
    } catch (err) {
      logger.logFailure(LOGGER_TITLE, 'Error ending quiz gracefully for error. Attempting to close session.');
      return Promise.resolve(closeSession(session, true)).then(() => {
        logger.logSuccess(LOGGER_TITLE, 'Session closed successfully.');
        throw err;
      });
    }
  }
}

class EndQuizScoreLimitReachedAction extends Action {
  do() {
    let session = this.getSession_();
    let messageSender = session.getMessageSender();
    let scoreLimit = session.getScores().getScoreLimit();
    return endQuiz(true, session, messageSender, messageSender.notifyQuizEndedScoreLimitReached, scoreLimit);
  }
}

class EndQuizNoQuestionsLeftAction extends Action {
  do() {
    let session = this.getSession_();
    let messageSender = session.getMessageSender();
    return endQuiz(true, session, messageSender, messageSender.notifyQuizEndedNoQuestionsLeft, session.getGameMode());
  }
}

class EndQuizTooManyWrongAnswersAction extends Action {
  do() {
    let session = this.getSession_();
    let wrongAnswersCount = session.getUnansweredQuestionsInARow();
    let messageSender = session.getMessageSender();
    return endQuiz(true, session, messageSender, messageSender.notifyQuizEndedTooManyWrongAnswers, wrongAnswersCount);
  }
}

class ShowAnswersAction extends Action {
  do() {
    let session = this.getSession_();
    let currentCard = session.getCurrentCard();
    return new Promise((fulfill, reject) => {
      this.fulfill_ = fulfill;
      let timer = setTimeout(() => {
        try {
          session.markCurrentCardAnswered();
          let scores = session.getScores();
          let answerersInOrder = scores.getCurrentQuestionAnswerersInOrder();
          let scoresForUser = scores.getAggregateScoreForUser();
          let answersForUser = scores.getCurrentQuestionsAnswersForUser();
          let pointsForAnswer = scores.getCurrentQuestionPointsForAnswer();
          Promise.resolve(session.getMessageSender().outputQuestionScorers(
            currentCard,
            answerersInOrder,
            answersForUser,
            pointsForAnswer,
            scoresForUser)).catch(err => {
            logger.logFailure(LOGGER_TITLE, 'Failed to output the scoredboard.', err);
          });

          if (scores.checkForWin()) {
            fulfill(new EndQuizScoreLimitReachedAction(session));
          } else {
            fulfill(new WaitAction(session, currentCard.newQuestionDelayAfterAnsweredInMs, new AskQuestionAction(session)));
          }
        } catch (err) {
          reject(err);
        }
      }, currentCard.additionalAnswerWaitTimeInMs);
      session.addTimer(timer);
    });
  }

  stop() {
    if (this.fulfill_) {
      this.fulfill_();
    }
  }

  tryAcceptUserInput(userId, userName, input) {
    return this.getSession_().tryAcceptAnswer(userId, userName, input);
  }
}

class ShowWrongAnswerAction extends Action {
  constructor(session, skipped) {
    super(session);
    this.skipped_ = skipped;
  }

  do() {
    let session = this.getSession_();
    let currentCard = session.getCurrentCard();
    return Promise.resolve(session.getMessageSender().showWrongAnswer(currentCard, this.skipped_)).catch(err => {
      let question = currentCard.question;
      logger.logFailure(LOGGER_TITLE, 'Failed to show timeout message for ' + question, err);
    }).then(() => {
      if (session.checkTooManyWrongAnswers()) {
        return new EndQuizTooManyWrongAnswersAction(session);
      } else {
        return new WaitAction(session, currentCard.newQuestionDelayAfterUnansweredInMs, new AskQuestionAction(session));
      }
    });
  }
}

class AskQuestionAction extends Action {
  constructor(session) {
    super(session);
    this.canBeSaved = true;
  }

  tryAcceptUserInput(userId, userName, input) {
    if (!this.readyForAnswers_) {
      return false;
    }
    let session = this.getSession_();
    let accepted = session.tryAcceptAnswer(userId, userName, input);
    if (accepted) {
      this.fulfill_(new ShowAnswersAction(session));
    }
    return accepted;
  }

  scheduleReveal_(numberOfReveals) {
    if (numberOfReveals === 0) {
      return;
    }

    let session = this.getSession_();
    let timer = setTimeout(() => {
      try {
        cardStrategies.createTextQuestionWithHint(session.getCurrentCard(), session).then(question => {
          if (question) {
            return session.getMessageSender().showQuestion(question, this.shownQuestionId_).catch(err => {
              logger.logFailure(LOGGER_TITLE, 'Failed to update reveal.', err);
            });
          }
        }).then(() => {
          this.scheduleReveal_(numberOfReveals - 1);
        }).catch(err => {
          this.reject_(err);
        });
      } catch(err) {
        this.reject_(err);
      }
    }, REVEAL_INTERVAL_IN_MS);
    session.addTimer(timer);
  }

  stop() {
    if (this.fulfill_) {
      this.fulfill_();
    }
  }

  skip() {
    try {
      if (this.fulfill_) {
        let session = this.getSession_();
        session.markCurrentCardUnanswered();
        this.fulfill_(new ShowWrongAnswerAction(session, true));
      }
    } catch (err) {
      logger.logFailure(LOGGER_TITLE, 'Failed to skip', err);
    }
  }

  do() {
    let session = this.getSession_();
    let nextCard = session.getNextCard();
    if (!nextCard) {
      return Promise.resolve(new EndQuizNoQuestionsLeftAction(session));
    }

    let preprocessPromise = Promise.resolve(nextCard);
    if (!nextCard.wasPreprocessed) {
      preprocessPromise = nextCard.preprocess(nextCard);
    }

    return preprocessPromise.then(card => {
      if (card === false) {
        return this.do();
      }
      card.wasPreprocessed = true;
      session.setCurrentCard(card);
      this.readyForAnswers_ = true;
      return card.createQuestion(card, session).then(question => {
        return Util.retryPromise(() => Promise.resolve(session.getMessageSender().showQuestion(question)), 3).catch(err => {
          logger.logFailure(LOGGER_TITLE, 'Error showing question', err);
        });
      }).then(shownQuestionId => {
        this.shownQuestionId_ = shownQuestionId;
        return new Promise((fulfill, reject) => {
          this.fulfill_ = fulfill;
          this.reject_ = reject;
          let timer = setTimeout(() => {
            try {
              session.markCurrentCardUnanswered();
              fulfill(new ShowWrongAnswerAction(session, false));
            } catch(err) {
              reject(err);
            }
          }, card.answerTimeLimitInMs);
          session.addTimer(timer);
          this.scheduleReveal_(card.numberOfReveals);
        });
      });
    });
  }
}

class AskInitialQuestionAction extends Action {
  do() {
    let session = this.getSession_();
    let word = wordData.getRandomWord();
  }
}

class StartAction extends Action {
  do() {
    const session = this.getSession_();
    return Promise.resolve(session.getMessageSender().notifyStarting(INITIAL_DELAY_IN_MS)).catch(err => {
      logger.logFailure(LOGGER_TITLE, 'Error showing starting message', err);
    }).then(() => {
      let askQuestionAction = new AskInitialQuestionAction(session);
      return new WaitAction(session, INITIAL_DELAY_IN_MS, askQuestionAction);
    });
  }
}

class WaitAction extends Action {
  constructor(session, waitInterval, nextAction) {
    super(session);
    this.waitInterval_ = waitInterval;
    this.nextAction_ = nextAction;
  }

  do() {
    return new Promise((fulfill, reject) => {
      this.fulfill_ = fulfill;
      let timer = setTimeout(() => {
        fulfill(this.nextAction_);
      }, this.waitInterval_);
      this.getSession_().addTimer(timer);
    });
  }

  stop() {
    if (this.fulfill_) {
      this.fulfill_();
    }
  }
}

class SaveAction extends Action {
  constructor(session, savingUserId) {
    super(session);
    this.savingUserId_ = savingUserId;
  }

  do() {
    let session = this.getSession_();
    return Promise.resolve(closeSession(session, false)).then(() => {
      let saveData = session.createSaveData();
      return saveManager.save(saveData, this.savingUserId_, session.getName(), session.getGameModeIdentifier());
    }).then(() => {
      return session.getMessageSender().notifySaveSuccessful().catch(err => {
        logger.logFailure(LOGGER_TITLE, 'Error sending quiz save message', err);
      });
    }).catch(err => {
      logger.logFailure(LOGGER_TITLE, 'Error saving', err);
      return new EndQuizForErrorAction(session);
    });
  }
}

function chainActions(locationId, action) {
  let session = state.shiritoriManager.sessionForLocationId[locationId];
  if (!action || !action.do || !session) {
    return Promise.resolve();
  }
  state.shiritoriManager.currentActionForLocationId[locationId] = action;

  try {
    return Promise.resolve(action.do()).then(result => {
      session.clearTimers();
      return chainActions(locationId, result);
    }).catch(err => {
      logger.logFailure(LOGGER_TITLE, 'Error', err);
      return chainActions(locationId, new EndQuizForErrorAction(session)).then(() => {
        return END_STATUS_ERROR;
      });
    });
  } catch (err) {
    logger.logFailure(LOGGER_TITLE, 'Error in chainActions. Closing the session.', err);
    let messageSender = session.getMessageSender();
    return Promise.resolve(endQuiz(true, session, messageSender, messageSender.notifyQuizEndedError)).then(() => {
      return END_STATUS_ERROR;
    });
  }
}

/* EXPORT */

function verifySessionNotInProgress(locationId) {
  assert(!isSessionInProgressAtLocation(locationId), 'Already a session in progress there.');
}

class ShiritoriManager {
  startSession(session, locationId) {
    verifySessionNotInProgress(locationId);
    setSessionForLocationId(session, locationId);
    return chainActions(locationId, new StartAction(session));
  }

  isSessionInProgressAtLocation(locationId) {
    return isSessionInProgressAtLocation(locationId);
  }

  processUserInput(locationId, userId, userName, input) {
    input = input.toLowerCase();
    let currentAction = state.shiritoriManager.currentActionForLocationId[locationId];
    if (!currentAction) {
      return false;
    }
    if (currentAction.tryAcceptUserInput) {
      return currentAction.tryAcceptUserInput(userId, userName, input);
    }
    return false;
  }

  stop(locationId, cancelingUserId, cancelingUserIsAdmin) {
    return stopQuizCommand(locationId, cancelingUserId, cancelingUserIsAdmin);
  }
}

module.exports = new ShiritoriManager();
module.exports.END_STATUS_ERROR = END_STATUS_ERROR;
