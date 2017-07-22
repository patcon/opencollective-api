import _ from 'lodash';
import app from '../server/index';
import async from 'async';
import { expect } from 'chai';
import request from 'supertest-as-promised';
import chanceLib from 'chance';
import * as utils from '../test/utils';
import roles from '../server/constants/roles';
import sinon from 'sinon';
import emailLib from '../server/lib/email';
import stripeMock from './mocks/stripe';
import models from '../server/models';
import {appStripe} from '../server/gateways/stripe';

const chance = chanceLib.Chance();

const application = utils.data('application');
const userData = utils.data('user1');
const userData2 = utils.data('user2');
const userData3 = utils.data('user3');
const publicCollectiveData = utils.data('collective1');
const transactionsData = utils.data('transactions1').transactions;

describe('collectives.routes.test.js', () => {

  let host, user, sandbox;

  before(() => {
    sandbox = sinon.sandbox.create();
    utils.clearbitStubBeforeEach(sandbox);
  });

  after(() => sandbox.restore());

  beforeEach(() => utils.resetTestDB());

  beforeEach('create host', () => models.User.create(utils.data('host1')).tap(u => host = u));
  beforeEach('create user', () => models.User.create(userData).tap(u => user = u));

  // Stripe stub.
  beforeEach(() => {
    const stub = sinon.stub(appStripe.accounts, 'create');
    stub.yields(null, stripeMock.accounts.create);
  });
  afterEach(() => {
    appStripe.accounts.create.restore();
  });

  /**
   * Create.
   */
  describe('#create', () => {

    it('fails creating a collective if no api_key', () =>
      request(app)
        .post('/collectives')
        .send({
          collective: publicCollectiveData
        })
        .expect(400)
    );

    it('fails creating a collective without name', (done) => {
      const collective = _.omit(publicCollectiveData, 'name');
      collective.users = [{email: userData.email, role: roles.ADMIN}];
      request(app)
        .post('/collectives')
        .send({
          api_key: application.api_key,
          collective
        })
        .expect(400)
        .end((e, res) => {
          expect(e).to.not.exist;
          expect(res.body).to.have.property('error');
          expect(res.body.error).to.have.property('message', 'notNull Violation: name cannot be null');
          expect(res.body.error).to.have.property('type', 'validation_failed');
          expect(res.body.error).to.have.property('fields');
          expect(res.body.error.fields).to.contain('name');
          done();
        });
    });

    describe('successfully create a collective', () => {
      let response, collective;

      beforeEach('subscribe host to collective.created notification', () => models.Notification.create({UserId: host.id, type: 'collective.created', channel: 'email'}));

      beforeEach('spy on emailLib', () => sinon.spy(emailLib, 'sendMessageFromActivity'));
      beforeEach('create the collective', (done) => {
        const users = [
              _.assign(_.omit(userData2, 'password'), {role: roles.ADMIN}),
              _.assign(_.omit(userData3, 'password'), {role: roles.ADMIN})];

        collective = Object.assign({}, publicCollectiveData, {users})
        collective.HostId = host.id;

        request(app)
          .post('/collectives')
          .send({
            api_key: application.api_key,
            collective
          })
          .expect(200)
          .end((e, res) => {
            expect(e).to.not.exist;
            response = res.body;
            done();
          })
      });

      afterEach('restore emailLib', () => emailLib.sendMessageFromActivity.restore());

      it('sends an email to the host', done => {
        setTimeout(() => {
          const activity = emailLib.sendMessageFromActivity.args[0][0];
          expect(activity.type).to.equal('collective.created');
          expect(activity.data).to.have.property('collective');
          expect(activity.data).to.have.property('host');
          expect(activity.data).to.have.property('user');
          expect(emailLib.sendMessageFromActivity.args[0][1].User.email).to.equal(host.email);
          done();
        }, 200);

      });

      it('returns the attributes of the collective', () => {
        expect(response).to.have.property('id');
        expect(response).to.have.property('name');
        expect(response).to.have.property('mission');
        expect(response).to.have.property('description');
        expect(response).to.have.property('longDescription');
        expect(response).to.have.property('image');
        expect(response).to.have.property('backgroundImage');
        expect(response).to.have.property('createdAt');
        expect(response).to.have.property('updatedAt');
        expect(response).to.have.property('twitterHandle');
        expect(response).to.have.property('website');
        expect(response).to.have.property('isActive', true);
      });

      it('assigns the users as members', () => {
        return Promise.all([
          models.Member.findOne({where: { UserId: host.id, role: roles.HOST }}),
          models.Member.count({where: { CollectiveId: 1, role: roles.ADMIN }}),
          models.Collective.find({where: { slug: collective.slug }})
          ])
        .then(results => {
          expect(results[0].CollectiveId).to.equal(1);
          expect(results[1]).to.equal(2);
          expect(results[2].LastEditedByUserId).to.equal(3);
        });
      });

    });

  });

  /**
   * Create from Github
   */
  describe('#createFromGithub', () => {

    it('fails creating a collective if param value is not github', () =>
      request(app)
        .post('/collectives?flow=blah')
        .send({
          payload: publicCollectiveData
        })
        .expect(400)
    );

    it('fails creating a collective if no api key', () =>
      request(app)
        .post('/collectives?flow=github')
        .send({
          payload: publicCollectiveData
        })
        .expect(400)
    );

    it('fails creating a collective without payload', () =>
      request(app)
        .post('/collectives?flow=github')
        .send({
          collective: publicCollectiveData,
          api_key: application.api_key
        })
        .expect(400)
    );

    describe('Successfully create a collective and ', () => {

      const { ConnectedAccount } = models;

      beforeEach(() => {
        const { User } = models;

        // create connected account like the oauth happened
        let preCA;
        return ConnectedAccount.create({
          username: 'asood123',
          provider: 'github',
          secret: 'xxxxx'
        })
        .then(ca => {
          preCA = ca;
          return User.create({email: 'githubuser@gmail.com'});
        })
        .then(user => user.addConnectedAccount(preCA));
      });

      beforeEach(() => sinon.spy(emailLib, 'send'));

      afterEach(() => emailLib.send.restore());

      it('assigns contributors as users with connectedAccounts', () =>
        request(app)
        .post('/collectives?flow=github')
        .set('Authorization', `Bearer ${user.jwt({ scope: 'connected-account', username: 'asood123', connectedAccountId: 1})}`)
        .send({
          payload: {
            collective: {
              name:'Loot',
              slug:'Loot',
              mission: 'mission statement'
            },
            users: ['asood123', 'oc'],
            github_username: 'asood123'
          },
          api_key: application.api_key
        })
        .expect(200)
        .toPromise()
        .tap(res => {
          expect(res.body).to.have.property('id');
          expect(res.body).to.have.property('name', 'Loot');
          expect(res.body).to.have.property('slug', 'loot');
          expect(res.body).to.have.property('mission', 'mission statement');
          expect(res.body).to.have.property('description');
          expect(res.body).to.have.property('longDescription');
          expect(res.body).to.have.property('isActive', false);
          expect(emailLib.send.lastCall.args[1]).to.equal('githubuser@gmail.com');
        })
        .then(() => ConnectedAccount.findOne({where: {username: 'asood123'}}))
        .then(ca => {
          expect(ca).to.have.property('provider', 'github');
          return ca.getUser();
        })
        .then(user => expect(user).to.exist)
        .then(() => ConnectedAccount.findOne({where: {username: 'oc'}}))
        .then(ca => {
          expect(ca).to.have.property('provider', 'github');
          return ca.getUser();
        })
        .tap(user => expect(user).to.exist)
        .then(caUser => caUser.getCollectives({paranoid: false})) // because we are setting deletedAt
        .tap(collectives => expect(collectives).to.have.length(1))
        .tap(collectives => expect(collectives[0].LastEditedByUserId).to.equal(3))
        .then(() => models.Member.findAll())
        .then(Members => {
          expect(Members).to.have.length(3);
          expect(Members[0]).to.have.property('role', roles.ADMIN);
          expect(Members[1]).to.have.property('role', roles.HOST);
          expect(Members[2]).to.have.property('role', roles.ADMIN);
          return null;
        }))
    });

  });

  /**
   * Get.
   */
  describe('#get', () => {

    let publicCollective;

    const stubStripe = () => {
      const stub = sinon.stub(appStripe.accounts, 'create');
      const mock = stripeMock.accounts.create;
      mock.email = chance.email();
      stub.yields(null, mock);
    };

    // beforeEach(() => utils.resetTestDB());

    beforeEach(() => {
      appStripe.accounts.create.restore();
      stubStripe();
    });

    // Create the public collective with user.
    beforeEach('create public collective with host', (done) => {
      request(app)
        .post('/collectives')
        .send({
          api_key: application.api_key,
          collective: Object.assign({}, publicCollectiveData, { isActive: true, slug: 'another', HostId: host.id, users: [ Object.assign({}, userData, { role: roles.ADMIN} )]})
        })
        .expect(200)
        .end((e, res) => {
          expect(e).to.not.exist;
          models.Collective
            .findById(parseInt(res.body.id))
            .tap((g) => {
              publicCollective = g;
              done();
            })
            .catch(done);
        });
    });

    beforeEach(() => models.StripeAccount
      .create({ stripePublishableKey: stripeMock.accounts.create.keys.publishable })
      .tap(account => host.setStripeAccount(account))
      .tap(account => user.setStripeAccount(account)));

    // Create another user.
    beforeEach('create a new payment method for user', () => models.PaymentMethod.create({UserId: user.id}))

    // Create a transaction for collective1.
    beforeEach('create a transaction for collective 1', () =>
      request(app)
        .post(`/collectives/${publicCollective.id}/transactions`)
        .set('Authorization', `Bearer ${user.jwt()}`)
        .send({
          api_key: application.api_key,
          transaction: Object.assign({}, transactionsData[8], { netAmountInCollectiveCurrency: transactionsData[8].amount})
        })
        .expect(200)
    );

    it('fails getting an undefined collective', () =>
      request(app)
        .get(`/collectives/undefined?api_key=${application.api_key}`)
        .expect(404)
    );

    it('successfully get a collective', (done) => {
      request(app)
        .get(`/collectives/${publicCollective.id}?api_key=${application.api_key}`)
        .expect(200)
        .end((e, res) => {
          expect(e).to.not.exist;
          expect(res.body).to.have.property('id', publicCollective.id);
          expect(res.body).to.have.property('name', publicCollective.name);
          expect(res.body).to.have.property('isActive', true);
          expect(res.body).to.have.property('stripeAccount');
          expect(res.body).to.have.property('yearlyIncome');
          expect(res.body).to.have.property('backersCount');
          expect(res.body).to.have.property('related');
          expect(res.body.tags).to.eql(publicCollective.tags);
          expect(res.body).to.have.property('isSupercollective', false);
          expect(res.body.stripeAccount).to.have.property('stripePublishableKey', stripeMock.accounts.create.keys.publishable);
          done();
        });
    });

    it('successfully get a collective by its slug (case insensitive)', (done) => {
      request(app)
        .get(`/collectives/${publicCollective.slug.toUpperCase()}?api_key=${application.api_key}`)
        .expect(200)
        .end((e, res) => {
          expect(e).to.not.exist;
          expect(res.body).to.have.property('id', publicCollective.id);
          expect(res.body).to.have.property('name', publicCollective.name);
          expect(res.body).to.have.property('isActive', true);
          expect(res.body).to.have.property('stripeAccount');
          expect(res.body.stripeAccount).to.have.property('stripePublishableKey', stripeMock.accounts.create.keys.publishable);
          done();
        });
    });

    describe('Transactions/Budget', () => {

      const transactions = [];
      let totTransactions = 0;
      let totDonations = 0;

      // Create collective2
      beforeEach('create collective 2', () =>
        models.Collective.create({HostId: host.id, name: "collective 2", slug: "collective2"}));

        // Create transactions for publicCollective.
      beforeEach('create transactions for public collective', (done) => {
        async.each(transactionsData, (transaction, cb) => {
          if (transaction.amount < 0)
            totTransactions += transaction.amount;
          else
            totDonations += transaction.amount;

          request(app)
            .post(`/collectives/${publicCollective.id}/transactions`)
            .set('Authorization', `Bearer ${user.jwt()}`)
            .send({
              api_key: application.api_key,
              transaction: _.extend({}, transaction, { netAmountInCollectiveCurrency: transaction.amount, approved: true })
            })
            .expect(200)
            .end((e, res) => {
              expect(e).to.not.exist;
              transactions.push(res.body);
              cb();
            });
        }, done);
      });

      // Create a subscription for PublicCollective.
      beforeEach(() => models.Subscription
        .create(utils.data('subscription1'))
        .then(subscription => models.Order.create({
          amount: 999,
          currency: 'USD',
          UserId: user.id,
          CollectiveId: publicCollective.id,
          SubscriptionId: subscription.id
        }))
        .then(order => models.Transaction.createFromPayload({
            transaction: Object.assign({}, transactionsData[7], { netAmountInCollectiveCurrency: transactionsData[7].amount, OrderId: order.id}),
            user,
            collective: publicCollective,
          })));

      it('successfully get a collective with remaining budget and yearlyIncome', (done) => {
        request(app)
          .get(`/collectives/${publicCollective.id}`)
          .send({
            api_key: application.api_key
          })
          .expect(200)
          .end((e, res) => {
            expect(e).to.not.exist;
            const g = res.body;
            expect(g).to.have.property('balance', parseInt((totDonations + totTransactions + transactionsData[7].amount + transactionsData[8].amount).toFixed(0), 10));
            expect(g).to.have.property('yearlyIncome', (transactionsData[7].amount + transactionsData[7].amount * 12)); // one is a single payment and other is a subscription
            done();
          });
      });

      it('successfully get a collective\'s users if it is public', (done) => {
        request(app)
          .get(`/collectives/${publicCollective.id}/users?api_key=${application.api_key}`)
          .expect(200)
          .end((e, res) => {
            expect(e).to.not.exist;
            const userData = res.body[0];
            console.log(res.body);
            expect(userData.firstName).to.equal(user.public.firstName);
            expect(userData.lastName).to.equal(user.public.lastName);
            expect(userData.name).to.equal(user.public.name);
            expect(userData.username).to.equal(user.public.username);
            expect(userData.role).to.equal(roles.ADMIN);
            done();
          });
      });

    });

  });

  /**
   * Update.
   */
  describe('#update', () => {

    let collective;
    let user2;
    let user3;
    let user4;
    const collectiveNew = {
      name: 'new name',
      mission: 'new mission',
      description: 'new desc',
      longDescription: 'long description',
      budget: 1000000,
      burnrate: 10000,
      image: 'http://opencollective.com/assets/image.svg',
      backgroundImage: 'http://opencollective.com/assets/backgroundImage.png',
      isActive: true,
      settings: { lang: 'fr' },
      otherprop: 'value'
    };

    // Create the collective with user.
    beforeEach('create public collective with host', (done) => {
      request(app)
        .post('/collectives')
        .send({
          api_key: application.api_key,
          collective: Object.assign({}, publicCollectiveData, {
            slug: 'public-collective',
            name: 'public collective with host',
            HostId: host.id,
            users: [ Object.assign({}, userData, { role: roles.ADMIN} ) ]
          })
        })
        .expect(200)
        .end((e, res) => {
          expect(e).to.not.exist;
          models.Collective
            .findById(parseInt(res.body.id))
            .tap((g) => {
              collective = g;
              done();
            })
            .catch(done);
        });
    });

    // Create another user.
    beforeEach(() => models.User.create(utils.data('user2')).tap(u => user2 = u));

    // Create another user that is a backer.
    beforeEach(() => models.User.create(utils.data('user3'))
      .tap(u => user3 = u)
      .then(() => collective.addUserWithRole(user3, roles.BACKER)));

    // Create another user that is a member.
    beforeEach(() => models.User.create(utils.data('user4'))
      .tap(u => user4 = u)
      .then(() => collective.addUserWithRole(user4, roles.ADMIN)));

    it('fails updating a collective if not authenticated', (done) => {
      request(app)
        .put(`/collectives/${collective.id}`)
        .send({
          api_key: application.api_key,
          collective: collectiveNew
        })
        .expect(401)
        .end(done);
    });

    it('fails updating a collective if the user authenticated has no access', (done) => {
      request(app)
        .put(`/collectives/${collective.id}`)
        .set('Authorization', `Bearer ${user2.jwt()}`)
        .send({
          api_key: application.api_key,
          collective: collectiveNew
        })
        .expect(403)
        .end(done);
    });

    it('fails updating a collective if the user authenticated is a viewer', (done) => {
      request(app)
        .put(`/collectives/${collective.id}`)
        .set('Authorization', `Bearer ${user3.jwt()}`)
        .send({
          api_key: application.api_key,
          collective: collectiveNew
        })
        .expect(403)
        .end(done);
    });

    it('fails updating a collective if no data passed', (done) => {
      request(app)
        .put(`/collectives/${collective.id}?api_key=${application.api_key}`)
        .set('Authorization', `Bearer ${user.jwt()}`)
        .expect(400)
        .end(done);
    });

    it('successfully updates a collective if authenticated as a ADMIN', (done) => {
      request(app)
        .put(`/collectives/${collective.id}`)
        .set('Authorization', `Bearer ${user4.jwt()}`)
        .send({
          api_key: application.api_key,
          collective: collectiveNew
        })
        .expect(200)
        .end(done);
    });

    it('successfully udpates a collective if authenticated as a user', (done) => {
      request(app)
        .put(`/collectives/${collective.id}`)
        .set('Authorization', `Bearer ${user.jwt()}`)
        .send({
          api_key: application.api_key,
          collective: collectiveNew
        })
        .expect(200)
        .end((e, res) => {
          expect(e).to.not.exist;
          expect(res.body).to.have.property('id', collective.id);
          expect(res.body).to.have.property('name', collectiveNew.name);
          expect(res.body).to.have.property('mission', collectiveNew.mission);
          expect(res.body).to.have.property('description', collectiveNew.description);
          expect(res.body).to.have.property('longDescription', collectiveNew.longDescription);
          expect(res.body.settings).to.have.property('lang', collectiveNew.settings.lang);
          expect(res.body).to.have.property('image', collectiveNew.image);
          expect(res.body).to.have.property('backgroundImage', collectiveNew.backgroundImage);
          expect(res.body).to.have.property('isActive', collectiveNew.isActive);
          expect(res.body).to.not.have.property('otherprop');
          expect(new Date(res.body.createdAt).getTime()).to.equal(new Date(collective.createdAt).getTime());
          expect(new Date(res.body.updatedAt).getTime()).to.not.equal(new Date(collective.updatedAt).getTime());
          done();
        });
    });

    it('successfully create a collective with HOST and assign same person to be a ADMIN and a BACKER', () =>
      /* TODO: this works but we'll need to do a lot refactoring.
       * Need to find a way to call this with one line: like collective.addUser()
       */
      models.Member.create({
        UserId: user3.id,
        CollectiveId: collective.id,
        role: roles.ADMIN
      })
      .then(() => models.Member.findAll({ where: { UserId: user3.id, CollectiveId: collective.id }}))
      .tap(rows => expect(rows.length).to.equal(2)));
  });

});