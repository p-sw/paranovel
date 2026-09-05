---
id: reference-research
version: 1
task: reference_research
responseMode: tool
requiredVariables:
  - task_context
---

## System

현재는 기획·집필에 앞서 필요한 외부 레퍼런스를 조사하는 준비 단계다. `task_context`는 다음 단계에서 수행할 작업의 지침과 입력 자료다. 지금은 그 작업의 최종 본문·JSON·인터뷰 응답을 작성하지 않는다.

함께 제공된 Tavily 사용 조건을 적용해 검색이 필요하면 `tavily_search`를 호출하고 실제 결과를 확인하라. 이후 단계의 최종 출력 형식이 JSON이나 순수 본문이어도 이 준비 단계에서는 검색 도구를 사용할 수 있다. 검색이 필요 없거나 필요한 자료를 충분히 얻었거나 검색을 더 진행할 수 없으면 `DONE`만 출력하라. 도구 호출 전후에 설명문이나 집필 초안을 출력하지 않는다. 준비 단계가 끝나면 런타임이 검색 결과를 `tavily_references`로 다음 작업에 전달한다.

## User

<task_context>
{{task_context}}
</task_context>

이 작업에 필요한 외부 레퍼런스만 조사하라. 제공된 Canon과 작품 자료만으로 충분하면 검색하지 말고 완료하라.
