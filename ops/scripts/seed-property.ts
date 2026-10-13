// Lists Jangteo's three curated demo properties on the live registry and badges them verified.
// Idempotent: a property whose name is already listed is skipped.  cd ops && node scripts/seed-property.ts
import { parseEther } from "viem";
import { giwa, write } from "../src/chain.ts";
import { config } from "../src/config.ts";
import { propertyAbi, propertyAddress } from "../src/property.ts";

const deployer = config.wallets.deployer!;
const addr = propertyAddress()!;
const DAYS = 86_400n;
const W = (won: number) => parseEther(String(won));

const seeds = [
  {
    meta: {
      name: "Gangnam Riverside, Building 101",
      nameKo: "강남 리버사이드 101동",
      location: "Gangnam-gu, Seoul",
      locationKo: "서울 강남구",
      kind: "apartment",
      areaM2: 84,
      description:
        "A simulated 84 m² three-room apartment in a riverside complex, rented to a long-term tenant. Rent is paid to holders every month; the property is sold when the complex is redeveloped. Testnet demo: no real building or tenant.",
      descriptionKo:
        "한강변 단지의 84㎡ 방 세 칸 아파트(모의 자산)로, 장기 세입자에게 임대 중이에요. 임대료는 매달 지분 보유자에게 지급되고, 재건축 때 매각돼요. 테스트넷 데모라서 실제 건물이나 세입자는 없어요.",
      images: ["/property/gangnam.svg"],
    },
    terms: { totalShares: 50_000n, minShares: 5_000n, price: W(10_000), duration: 30n * DAYS, rentPerPeriod: W(1_250_000), reserveMonths: 3n },
  },
  {
    meta: {
      name: "Jeonju Hanok Guesthouse",
      nameKo: "전주 한옥 게스트하우스",
      location: "Wansan-gu, Jeonju",
      locationKo: "전주시 완산구",
      kind: "house",
      areaM2: 120,
      description:
        "A simulated 120 m² hanok in the old town, run as a guesthouse. Its monthly lease is shared by every holder, with six months of rent held in reserve. Testnet demo: no real house.",
      descriptionKo:
        "한옥마을 안의 120㎡ 한옥(모의 자산)으로, 게스트하우스로 운영돼요. 매달 받는 임대료를 모든 지분 보유자가 나눠 받고, 6개월치 임대료가 적립금으로 남아 있어요. 테스트넷 데모라서 실제 집은 없어요.",
      images: ["/property/jeonju.svg"],
    },
    terms: { totalShares: 20_000n, minShares: 2_000n, price: W(10_000), duration: 30n * DAYS, rentPerPeriod: W(700_000), reserveMonths: 6n },
  },
  {
    meta: {
      name: "Jeju Farmland, Aewol",
      nameKo: "제주 애월 농지",
      location: "Aewol-eup, Jeju",
      locationKo: "제주시 애월읍",
      kind: "land",
      areaM2: 1650,
      description:
        "A simulated 1,650 m² plot of farmland below Hallasan. Land pays no rent: holders are paid when the plot is sold. Testnet demo: no real land.",
      descriptionKo:
        "한라산 아래 1,650㎡ 농지(모의 자산)예요. 토지라서 임대료는 없고, 땅이 팔릴 때 지분 보유자에게 지급돼요. 테스트넷 데모라서 실제 땅은 없어요.",
      images: ["/property/jeju.svg"],
    },
    terms: { totalShares: 10_000n, minShares: 1_000n, price: W(10_000), duration: 30n * DAYS, rentPerPeriod: 0n, reserveMonths: 0n },
  },
];

const n = await giwa.readContract({ address: addr, abi: propertyAbi, functionName: "count" });
const existing = new Set<string>();
for (let i = 0n; i < n; i++) {
  try {
    existing.add((JSON.parse(await giwa.readContract({ address: addr, abi: propertyAbi, functionName: "metadata", args: [i] })) as { name: string }).name);
  } catch {
    /* not JSON */
  }
}
for (const s of seeds) {
  if (existing.has(s.meta.name)) {
    console.log("exists", s.meta.name);
    continue;
  }
  const { result, hash } = await write({ key: deployer.key, address: addr, abi: propertyAbi, functionName: "create", args: [s.terms, JSON.stringify(s.meta)] });
  const id = result as bigint;
  await write({ key: deployer.key, address: addr, abi: propertyAbi, functionName: "setVerified", args: [id, true] });
  console.log(`#${id} ${s.meta.name} ${hash}`);
}
