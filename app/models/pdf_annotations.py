from typing import Literal

from pydantic import BaseModel, Field, model_validator


class PdfRectangle(BaseModel):
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    width: float = Field(gt=0, le=1)
    height: float = Field(gt=0, le=1)

    @model_validator(mode='after')
    def within_page(self):
        if self.x + self.width > 1.001 or self.y + self.height > 1.001:
            raise ValueError('Annotation outside page')
        return self


class PdfAnnotation(BaseModel):
    id: str = Field(pattern=r'^[a-zA-Z0-9-]{1,80}$')
    page: int = Field(ge=1)
    kind: Literal['highlight', 'underline', 'sticky']
    color: Literal['yellow', 'green', 'pink', 'blue'] = 'yellow'
    rects: list[PdfRectangle] = Field(min_length=1, max_length=1000)
    text: str = Field(default='', max_length=20000)
