import React from 'react'
import {BskyAgent, AtpPersistSessionHandler} from '@atproto/api'

import {networkRetry} from '#/lib/async/retry'
import {logger} from '#/logger'
import * as persisted from '#/state/persisted'
import {PUBLIC_BSKY_AGENT} from '#/data'

export type SessionAccount = persisted.PersistedAccount

export type StateContext = {
  agent: BskyAgent
  isInitialLoad: boolean
  isSwitchingAccounts: boolean
  accounts: persisted.PersistedAccount[]
  currentAccount: persisted.PersistedAccount | undefined
  hasSession: boolean
}
export type ApiContext = {
  createAccount: (props: {
    service: string
    email: string
    password: string
    handle: string
    inviteCode?: string
  }) => Promise<void>
  login: (props: {
    service: string
    identifier: string
    password: string
  }) => Promise<void>
  logout: () => Promise<void>
  initSession: (account: persisted.PersistedAccount) => Promise<void>
  resumeSession: (account?: persisted.PersistedAccount) => Promise<void>
  removeAccount: (
    account: Partial<Pick<persisted.PersistedAccount, 'handle' | 'did'>>,
  ) => void
  selectAccount: (account: persisted.PersistedAccount) => Promise<void>
  updateCurrentAccount: (
    account: Partial<
      Pick<persisted.PersistedAccount, 'handle' | 'email' | 'emailConfirmed'>
    >,
  ) => void
  clearCurrentAccount: () => void
}

const StateContext = React.createContext<StateContext>({
  agent: PUBLIC_BSKY_AGENT,
  hasSession: false,
  isInitialLoad: true,
  isSwitchingAccounts: false,
  accounts: [],
  currentAccount: undefined,
})

const ApiContext = React.createContext<ApiContext>({
  createAccount: async () => {},
  login: async () => {},
  logout: async () => {},
  initSession: async () => {},
  resumeSession: async () => {},
  removeAccount: () => {},
  selectAccount: async () => {},
  updateCurrentAccount: () => {},
  clearCurrentAccount: () => {},
})

function createPersistSessionHandler(
  account: persisted.PersistedAccount,
  persistSessionCallback: (props: {
    expired: boolean
    refreshedAccount: persisted.PersistedAccount
  }) => void,
): AtpPersistSessionHandler {
  return function persistSession(event, session) {
    const expired = !(event === 'create' || event === 'update')
    const refreshedAccount = {
      service: account.service,
      did: session?.did || account.did,
      handle: session?.handle || account.handle,
      email: session?.email || account.email,
      emailConfirmed: session?.emailConfirmed || account.emailConfirmed,
      refreshJwt: session?.refreshJwt, // undefined when expired or creation fails
      accessJwt: session?.accessJwt, // undefined when expired or creation fails
    }

    logger.debug(
      `session: BskyAgent.persistSession`,
      {
        expired,
        did: refreshedAccount.did,
        handle: refreshedAccount.handle,
      },
      logger.DebugContext.session,
    )

    persistSessionCallback({
      expired,
      refreshedAccount,
    })
  }
}

export function Provider({children}: React.PropsWithChildren<{}>) {
  const [state, setState] = React.useState<StateContext>({
    agent: PUBLIC_BSKY_AGENT,
    hasSession: false,
    isInitialLoad: true, // try to resume the session first
    isSwitchingAccounts: false,
    accounts: persisted.get('session').accounts,
    currentAccount: undefined, // assume logged out to start
  })

  const upsertAccount = React.useCallback(
    (account: persisted.PersistedAccount, expired = false) => {
      setState(s => {
        return {
          ...s,
          currentAccount: expired ? undefined : account,
          accounts: [account, ...s.accounts.filter(a => a.did !== account.did)],
        }
      })
    },
    [setState],
  )

  // TODO have not connected this yet
  const createAccount = React.useCallback<ApiContext['createAccount']>(
    async ({service, email, password, handle, inviteCode}: any) => {
      logger.debug(
        `session: creating account`,
        {
          service,
          handle,
        },
        logger.DebugContext.session,
      )

      const agent = new BskyAgent({service})

      await agent.createAccount({
        handle,
        password,
        email,
        inviteCode,
      })

      if (!agent.session) {
        throw new Error(`session: createAccount failed to establish a session`)
      }

      const account: persisted.PersistedAccount = {
        service,
        did: agent.session.did,
        handle: agent.session.handle,
        email: agent.session.email!, // TODO this is always defined?
        emailConfirmed: false,
        refreshJwt: agent.session.refreshJwt,
        accessJwt: agent.session.accessJwt,
      }

      agent.setPersistSessionHandler(
        createPersistSessionHandler(account, ({expired, refreshedAccount}) => {
          upsertAccount(refreshedAccount, expired)
        }),
      )

      upsertAccount(account)

      logger.debug(
        `session: created account`,
        {
          service,
          handle,
        },
        logger.DebugContext.session,
      )
    },
    [upsertAccount],
  )

  const login = React.useCallback<ApiContext['login']>(
    async ({service, identifier, password}) => {
      logger.debug(
        `session: login`,
        {
          service,
          identifier,
        },
        logger.DebugContext.session,
      )

      const agent = new BskyAgent({service})

      await agent.login({identifier, password})

      if (!agent.session) {
        throw new Error(`session: login failed to establish a session`)
      }

      const account: persisted.PersistedAccount = {
        service,
        did: agent.session.did,
        handle: agent.session.handle,
        email: agent.session.email!, // TODO this is always defined?
        emailConfirmed: agent.session.emailConfirmed || false,
        refreshJwt: agent.session.refreshJwt,
        accessJwt: agent.session.accessJwt,
      }

      agent.setPersistSessionHandler(
        createPersistSessionHandler(account, ({expired, refreshedAccount}) => {
          upsertAccount(refreshedAccount, expired)
        }),
      )

      setState(s => ({...s, agent}))
      upsertAccount(account)

      logger.debug(
        `session: logged in`,
        {
          service,
          identifier,
        },
        logger.DebugContext.session,
      )
    },
    [upsertAccount],
  )

  const logout = React.useCallback<ApiContext['logout']>(async () => {
    logger.debug(`session: logout`, {}, logger.DebugContext.session)
    setState(s => {
      return {
        ...s,
        agent: PUBLIC_BSKY_AGENT,
        currentAccount: undefined,
        accounts: s.accounts.map(a => ({
          ...a,
          refreshJwt: undefined,
          accessJwt: undefined,
        })),
      }
    })
  }, [setState])

  const initSession = React.useCallback<ApiContext['initSession']>(
    async account => {
      logger.debug(
        `session: initSession`,
        {
          did: account.did,
          handle: account.handle,
        },
        logger.DebugContext.session,
      )

      const agent = new BskyAgent({
        service: account.service,
        persistSession: createPersistSessionHandler(
          account,
          ({expired, refreshedAccount}) => {
            upsertAccount(refreshedAccount, expired)
          },
        ),
      })

      await networkRetry(3, () =>
        agent.resumeSession({
          accessJwt: account.accessJwt || '',
          refreshJwt: account.refreshJwt || '',
          did: account.did,
          handle: account.handle,
        }),
      )

      setState(s => ({...s, agent}))
      upsertAccount(account)
    },
    [upsertAccount],
  )

  const resumeSession = React.useCallback<ApiContext['resumeSession']>(
    async account => {
      try {
        if (account) {
          await initSession(account)
        }
      } catch (e) {
        logger.error(`session: resumeSession failed`, {error: e})
      } finally {
        setState(s => ({
          ...s,
          isInitialLoad: false,
        }))
      }
    },
    [initSession],
  )

  const removeAccount = React.useCallback<ApiContext['removeAccount']>(
    account => {
      setState(s => {
        return {
          ...s,
          accounts: s.accounts.filter(
            a => !(a.did === account.did || a.handle === account.handle),
          ),
        }
      })
    },
    [setState],
  )

  const updateCurrentAccount = React.useCallback<
    ApiContext['updateCurrentAccount']
  >(
    account => {
      setState(s => {
        const currentAccount = s.currentAccount

        // ignore, should never happen
        if (!currentAccount) return s

        const updatedAccount = {
          ...currentAccount,
          handle: account.handle || currentAccount.handle,
          email: account.email || currentAccount.email,
          emailConfirmed:
            account.emailConfirmed !== undefined
              ? account.emailConfirmed
              : currentAccount.emailConfirmed,
        }

        return {
          ...s,
          currentAccount: updatedAccount,
          accounts: [
            updatedAccount,
            ...s.accounts.filter(a => a.did !== currentAccount.did),
          ],
        }
      })
    },
    [setState],
  )

  const selectAccount = React.useCallback<ApiContext['selectAccount']>(
    async account => {
      setState(s => ({...s, isSwitchingAccounts: true}))
      try {
        await initSession(account)
        setState(s => ({...s, isSwitchingAccounts: false}))
      } catch (e) {
        // reset this in case of error
        setState(s => ({...s, isSwitchingAccounts: false}))
        // but other listeners need a throw
        throw e
      }
    },
    [setState, initSession],
  )

  const clearCurrentAccount = React.useCallback(() => {
    setState(s => ({
      ...s,
      currentAccount: undefined,
    }))
  }, [setState])

  React.useEffect(() => {
    persisted.write('session', {
      accounts: state.accounts,
      currentAccount: state.currentAccount,
    })
  }, [state])

  React.useEffect(() => {
    return persisted.onUpdate(() => {
      const session = persisted.get('session')

      logger.debug(`session: onUpdate`, {}, logger.DebugContext.session)

      if (session.currentAccount) {
        if (session.currentAccount?.did !== state.currentAccount?.did) {
          logger.debug(
            `session: switching account`,
            {
              from: {
                did: state.currentAccount?.did,
                handle: state.currentAccount?.handle,
              },
              to: {
                did: session.currentAccount.did,
                handle: session.currentAccount.handle,
              },
            },
            logger.DebugContext.session,
          )

          initSession(session.currentAccount)
        }
      } else if (!session.currentAccount && state.currentAccount) {
        logger.debug(
          `session: logging out`,
          {
            did: state.currentAccount?.did,
            handle: state.currentAccount?.handle,
          },
          logger.DebugContext.session,
        )

        logout()
      }
    })
  }, [state, logout, initSession])

  const stateContext = React.useMemo(
    () => ({
      ...state,
      hasSession: !!state.currentAccount,
    }),
    [state],
  )

  const api = React.useMemo(
    () => ({
      createAccount,
      login,
      logout,
      initSession,
      resumeSession,
      removeAccount,
      selectAccount,
      updateCurrentAccount,
      clearCurrentAccount,
    }),
    [
      createAccount,
      login,
      logout,
      initSession,
      resumeSession,
      removeAccount,
      selectAccount,
      updateCurrentAccount,
      clearCurrentAccount,
    ],
  )

  return (
    <StateContext.Provider value={stateContext}>
      <ApiContext.Provider value={api}>{children}</ApiContext.Provider>
    </StateContext.Provider>
  )
}

export function useSession() {
  return React.useContext(StateContext)
}

export function useSessionApi() {
  return React.useContext(ApiContext)
}