import { describe, expect, it } from "vitest";
import {
  authenticateEmby,
  fetchEmbyEpisodeChildren,
  fetchEmbyItem,
  formatEmbyEpisodeDurationLines,
  formatEmbySingleDurationLine,
  searchEmbyItems,
  type EmbyFetch
} from "./embyClient";

describe("Emby 客户端", () => {
  it("通过用户名密码登录并读取 token", async () => {
    const calls: Array<{ url: string; body: string | null }> = [];
    const fetcher: EmbyFetch = (input, init) => {
      calls.push({
        url: inputToString(input),
        body: typeof init?.body === "string" ? init.body : null
      });
      return Promise.resolve(createResponse({
        User: { Id: "user-1", Name: "tester" },
        AccessToken: "token-1"
      }));
    };

    const session = await authenticateEmby(
      { serverUrl: "https://example.test:443", pathPrefix: "/emby" },
      { username: "tester", password: "secret" },
      fetcher
    );

    expect(session).toEqual({ userId: "user-1", userName: "tester", accessToken: "token-1" });
    expect(calls[0].url).toBe("https://example.test/emby/Users/AuthenticateByName");
    expect(calls[0].body).toContain("\"Username\":\"tester\"");
  });

  it("读取条目并把 RunTimeTicks 转成毫秒", async () => {
    const fetcher: EmbyFetch = () =>
      Promise.resolve(createResponse({
        Id: "item-1",
        Name: "Episode 1",
        Type: "Episode",
        ParentIndexNumber: 1,
        IndexNumber: 1,
        RunTimeTicks: 3_080_123_0000
      }));

    const item = await fetchEmbyItem(
      { serverUrl: "https://example.test/emby", pathPrefix: "" },
      { userId: "user-1", userName: "tester", accessToken: "token-1" },
      "item-1",
      fetcher
    );

    expect(item.durationMs).toBe(3_080_123);
    expect(item.seasonNumber).toBe(1);
    expect(item.episodeNumber).toBe(1);
  });

  it("读取下级剧集并生成真实集时长表", async () => {
    const fetcher: EmbyFetch = () =>
      Promise.resolve(createResponse({
        Items: [
          {
            Id: "episode-2",
            Name: "Episode 2",
            Type: "Episode",
            ParentIndexNumber: 1,
            IndexNumber: 2,
            MediaSources: [{ RunTimeTicks: 3_045_000_0000 }]
          },
          {
            Id: "episode-1",
            Name: "Episode 1",
            Type: "Episode",
            ParentIndexNumber: 1,
            IndexNumber: 1,
            RunTimeTicks: 3_080_000_0000
          }
        ]
      }));

    const items = await fetchEmbyEpisodeChildren(
      { serverUrl: "https://example.test", pathPrefix: "emby" },
      { userId: "user-1", userName: "tester", accessToken: "token-1" },
      "series-1",
      fetcher
    );

    expect(formatEmbyEpisodeDurationLines(items)).toBe("S01E01 51:20\nS01E02 50:45");
  });

  it("可通过名称和季集号模糊搜索候选并优先排序匹配项", async () => {
    const calls: string[] = [];
    const fetcher: EmbyFetch = (input) => {
      calls.push(inputToString(input));
      return Promise.resolve(createResponse({
        Items: [
          {
            Id: "movie-1",
            Name: "Movie One",
            Type: "Movie",
            RunTimeTicks: 6_000_000_0000
          },
          {
            Id: "episode-1",
            Name: "Movie Episode",
            Type: "Episode",
            ParentIndexNumber: 2,
            IndexNumber: 3,
            RunTimeTicks: 1_500_000_0000
          }
        ]
      }));
    };

    const items = await searchEmbyItems(
      { serverUrl: "https://example.test", pathPrefix: "emby" },
      { userId: "user-1", userName: "tester", accessToken: "token-1" },
      { searchTerm: "Movie S02E03", limit: 12 },
      fetcher
    );

    expect(calls[0]).toContain("/emby/Users/user-1/Items?");
    expect(calls[0]).toContain("SearchTerm=Movie");
    expect(calls[0]).toContain("IncludeItemTypes=Movie%2CSeries%2CSeason%2CEpisode");
    expect(items).toHaveLength(2);
    expect(items[0].id).toBe("episode-1");
    expect(formatEmbySingleDurationLine(items[0])).toBe("S02E03 25:00");
  });

  it("把浏览器网络层失败转换为中文诊断", async () => {
    const fetcher: EmbyFetch = () => Promise.reject(new TypeError("Failed to fetch"));

    await expect(
      authenticateEmby(
        { serverUrl: "https://example.test", pathPrefix: "emby" },
        { username: "tester", password: "secret" },
        fetcher
      )
    ).rejects.toThrow("通常是订阅服务未开放 CORS");
  });
});

function createResponse(payload: unknown): Awaited<ReturnType<EmbyFetch>> {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(payload)
  };
}

function inputToString(input: RequestInfo | URL): string {
  if (input instanceof URL) {
    return input.toString();
  }
  if (typeof input === "string") {
    return input;
  }
  return input.url;
}
