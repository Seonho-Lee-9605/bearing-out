# 베어링 장바구니 자동 담기 (비공개 저장소용)

구글 시트의 `구매요청`(구매대기·구매요청)을 읽어 IMKmall 장바구니에 담고, 결과(담김·미등록·확인필요)를 시트에 되돌려 씁니다.
**주문·결제는 하지 않습니다.** 장바구니에 담기까지만 합니다.

- `.github/workflows/imk-cart.yml` : 평일 07~19시(한국시간) 30분마다 + 수동 실행
- `runner/peek.js` : 담을 요청이 있는지만 확인 (없으면 1분 안에 종료)
- `runner/imk_cart.js` : 로그인 → 검색 → 담기 → 검증 → 시트에 결과 기록
- `runner/selectors.json` : IMKmall 화면에 맞춘 선택자 설정 (진단 결과로 채움)

## 필요한 비밀 값 (Settings > Secrets and variables > Actions > Secrets)
| 이름 | 내용 |
|---|---|
| `API_URL` | Apps Script 웹앱 주소 (…/exec) |
| `AUTO_TOKEN` | Apps Script 스크립트 속성의 AUTO_TOKEN 값 |
| `IMK_ID` | IMKmall 아이디 |
| `IMK_PW` | IMKmall 비밀번호 |

아이디·비밀번호는 이 저장소의 파일, 이슈, 채팅 등 어디에도 적지 않습니다. 비밀 저장칸에만 입력합니다.

## 실행 방식 (Actions > IMK 장바구니 담기 > Run workflow > mode)
1. `discover` : 화면 구조를 저장 (장바구니는 건드리지 않음)
2. `logincheck` : 로그인만 확인
3. `dryrun` : 검색만 해서 무엇을 담을지 로그로 보여 줌 (장바구니·시트 변경 없음)
4. `run` : 실제로 담기 (selectors.json 의 `verified` 가 true 일 때만)
