import axios, { AxiosError } from "axios";
import { readFile, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import parse from "parse-link-header";

// A bunch of TODOs at this point:
//  * better error reporting: not logged in, unexpected HTTP error, auth failure...

/**
 * The type of each of the data objects that we get out of an OCPI platform.
 *
 * We can assume almost nothing about those so it's just a record from string to pretty much anything.
 */
type OcpiClientOwnedObject = Record<string, any>;

/**
 * The identifiers of OCPI modules.
 *
 * This is restricted to the so-called 'Functional Modules', that serve data that can be exported using this tool
 */
export type ModuleID =
  | "cdrs"
  | "chargingprofiles"
  | "locations"
  | "sessions"
  | "tariffs"
  | "tokens";

export type OcpiModule<Name extends ModuleID> = {
  name: Name & string;
};
export const cdrs: OcpiModule<"cdrs"> = {
  name: "cdrs",
};
export const locations: OcpiModule<"locations"> = {
  name: "locations",
};
export const sessions: OcpiModule<"sessions"> = {
  name: "sessions",
};
export const tariffs: OcpiModule<"tariffs"> = {
  name: "tariffs",
};
export const tokens: OcpiModule<"tokens"> = {
  name: "tokens",
};

// as opposed to the INPUT_PARTY_ID_REGEX, defined in login.ts, which is more
// lenient in order to be more suitable for human input
export const SESSION_PARTY_ID_REGEX = /^[A-Z]{2}[A-Z0-9]{3}$/;

export function getModuleByName(moduleName: string): OcpiModule<any> | null {
  return (
    [cdrs, locations, sessions, tariffs, tokens].find(
      (m) => m.name === moduleName
    ) ?? null
  );
}

type OcpiPageParameters = {
  offset: number;
  limit: number;
};

export type OcpiResponse<T> = {
  data: T;
  status_code: number;
  status_message?: string;
  timestamp: string;
  nextPage?: OcpiPageParameters;
};

export type OcpiRole = "SENDER" | "RECEIVER";

export type OcpiEndpoint = {
  identifier: string;
  url: string;
  role?: OcpiRole;
};

export type OcpiVersion = "2.2.1" | "2.2" | "2.1.1" | "2.0" | "2.1";

export type OcpiSession = {
  token: string;
  partyId: string;
  version: OcpiVersion;
  endpoints: OcpiEndpoint[];
};

export type OcpiRequestMethod = "get" | "post" | "put" | "delete";

export async function ocpiRequest<T>(
  method: OcpiRequestMethod,
  url: string,
  fromPartyId?: string,
  toPartyId?: string
): Promise<OcpiResponse<T>> {
  const sessionObject = await loadSession();
  return ocpiRequestRetryingAuthTokenBase64(
    method,
    url,
    sessionObject.token,
    sessionObject.version,
    fromPartyId,
    toPartyId
  );
}

export async function ocpiRequestRetryingAuthTokenBase64<T>(
  method: OcpiRequestMethod,
  url: string,
  token: string,
  ocpiVersion?: OcpiVersion,
  fromPartyId?: string,
  toPartyId?: string
): Promise<OcpiResponse<T>> {
  const tryWithEncodedAuthTokenFirst =
    ocpiVersion === "2.2.1" || ocpiVersion === "2.2";

  const responseToFirstTry = await ocpiRequestWithGivenToken(
    method,
    url,
    token,
    tryWithEncodedAuthTokenFirst,
    fromPartyId,
    toPartyId
  );
  if ("isAxiosError" in responseToFirstTry && responseToFirstTry.isAxiosError) {
    const mayBeAuthenticationProblem =
      responseToFirstTry.response &&
      responseToFirstTry.response?.status >= 400 &&
      responseToFirstTry.response?.status < 500;
    if (mayBeAuthenticationProblem) {
      const responseToSecondTry = await ocpiRequestWithGivenToken(
        method,
        url,
        token,
        !tryWithEncodedAuthTokenFirst,
        fromPartyId,
        toPartyId
      );
      if (
        "isAxiosError" in responseToSecondTry &&
        responseToSecondTry.isAxiosError
      ) {
        throw responseToSecondTry;
      } else {
        return responseToSecondTry as OcpiResponse<T>;
      }
    } else {
      throw responseToFirstTry;
    }
  } else {
    return responseToFirstTry as OcpiResponse<T>;
  }
}

async function ocpiRequestWithGivenToken<T>(
  method: OcpiRequestMethod,
  url: string,
  token: string,
  encodeToken: boolean,
  fromPartyId?: string,
  toPartyId?: string
): Promise<OcpiResponse<T> | AxiosError> {
  const authHeaderValue =
    "Token " + (encodeToken ? Buffer.from(token).toString("base64") : token);

  return ocpiRequestWithLiteralAuthHeaderTokenValue(
    method,
    url,
    authHeaderValue,
    fromPartyId,
    toPartyId
  );
}

const ocpiRequestWithLiteralAuthHeaderTokenValue: <T>(
  method: OcpiRequestMethod,
  url: string,
  authHeaderValue: string,
  fromPartyId?: string,
  toPartyId?: string
) => Promise<OcpiResponse<T> | AxiosError> = async <T>(
  method: OcpiRequestMethod,
  url: string,
  authHeaderValue: string,
  fromPartyId?: string,
  toPartyId?: string
) => {
  const tracingHeaders = {
    "X-Request-ID": randomUUID(),
    "X-Correlation-ID": randomUUID(),
  };

  const routingHeaders = routingHeadersFromPartyIds(fromPartyId, toPartyId);

  let resp;
  try {
    resp = await axios(url, {
      method: method,
      headers: {
        Authorization: authHeaderValue,
        ...tracingHeaders,
        ...routingHeaders,
      },
    });
  } catch (error) {
    const axiosError = error as AxiosError;
    if (axiosError.isAxiosError) {
      return axiosError;
    } else throw error;
  }

  const headerLinks = parse(resp.headers["link"]);
  const linkToNextPage = headerLinks === null ? null : headerLinks["next"];
  const nextPage =
    linkToNextPage === null
      ? undefined
      : {
          offset: linkToNextPage?.offset,
          limit: linkToNextPage?.limit,
        };

  const ocpiResponse = { ...resp.data, nextPage } as OcpiResponse<T>;
  return ocpiResponse;
};

const routingHeadersFromPartyIds: (
  fromPartyId?: string,
  toPartyId?: string
) => Record<string, string> = (fromPartyId, toPartyId) => {
  const headers: Record<string, string> = {};
  if (fromPartyId) {
    if (!fromPartyId.match(SESSION_PARTY_ID_REGEX))
      throw new Error(`invalid from party ID: [${fromPartyId}]`);
    headers["OCPI-from-country-code"] = fromPartyId.slice(0, 2);
    headers["OCPI-from-party-id"] = fromPartyId.slice(2);
  }
  if (toPartyId) {
    if (!toPartyId.match(SESSION_PARTY_ID_REGEX))
      throw new Error(`invalid to party ID: [${toPartyId}]`);
    headers["OCPI-to-country-code"] = toPartyId.slice(0, 2);
    headers["OCPI-to-party-id"] = toPartyId.slice(2);
  }

  return headers;
};

export type NoSuchEndpoint = "no such endpoint";

/**
 * Fetch all data of a certain module from the OCPI platform that the tool is currently logged in to
 *
 * @param module The module to fetch data from
 * @returns A Node Readable that you can stream the OCPI objects from the module from
 */
export function fetchDataForModule<N extends ModuleID>(
  module: OcpiModule<N>
): Readable {
  let nextPage: OcpiPageParameters | "done" | "notstarted" = "notstarted";

  return new Readable({
    objectMode: true,
    read: async function (size: number) {
      console.debug(`Node streams engine called read, size = ${size}`);

      if (nextPage === "done") {
        console.debug(
          "read() called while page fetching is already done; returning without pushing"
        );
        return;
      }

      const firstPageParameters = { offset: 0, limit: size };
      const nextPageData = await pullPageOfData(
        module,
        nextPage === "notstarted" ? firstPageParameters : nextPage
      );
      if (nextPageData === "no such endpoint") {
        throw new Error(`no endpoint found for module ${module.name}`);
      }
      console.debug("Page fetched", nextPageData);

      nextPage = nextPageData.nextPage ?? "done";

      if (nextPageData["data"]) {
        nextPageData.data.forEach((object) => {
          const shouldContinue = this.push(object);
          console.debug("push returned", shouldContinue);
        });
      }

      console.debug("Done pushing");

      // end the stream if this is the last page
      if (nextPage === "done") {
        console.debug("No next page given in response, ending object stream");
        this.push(null);
      }
    },
  });
}

type OcpiPagedGetResponse<T> = {
  data?: T[];
  nextPage?: OcpiPageParameters;
};

async function pullPageOfData<N extends ModuleID>(
  module: OcpiModule<N>,
  page: OcpiPageParameters
): Promise<OcpiPagedGetResponse<OcpiClientOwnedObject> | NoSuchEndpoint> {
  const sess = await loadSession();
  const fromPartyId =
    sess.version === "2.2" || sess.version === "2.2.1"
      ? sess.partyId
      : undefined;

  const moduleUrl = sess.endpoints.find(
    (ep) => ep.identifier === module.name && ep.role !== "RECEIVER"
  );

  if (moduleUrl) {
    return ocpiRequest(
      "get",
      `${moduleUrl.url}?offset=${page.offset}&limit=${page.limit}`,
      fromPartyId
    );
  } else return "no such endpoint";
}

export async function loadSession(): Promise<OcpiSession> {
  const sessionFileContents = await readFile(sessionFile(), {
    encoding: "utf-8",
  });
  return JSON.parse(sessionFileContents).session as OcpiSession;
}

export async function setSession(session: OcpiSession): Promise<void> {
  return writeFile(sessionFile(), JSON.stringify({ session }), {
    mode: "0600",
  });
}

const sessionFile: () => string = () =>
  process.env.OCPI_SESSION_FILE ?? `${process.env.HOME}/.ocpi`;
